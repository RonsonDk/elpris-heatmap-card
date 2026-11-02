/*
 * elpris-heatmap-card
 * Heatmap over elpriser: 24 timer (rækker) x 7 dage (kolonner).
 *
 * - I dag og i morgen læses fra attributten "prices" på Strømligning-sensorerne
 * - Tidligere dage læses fra Home Assistants historik for prissensoren
 * - Altid 7 kolonner: i morgen tilgængelig = 5 dage tilbage + i dag + i morgen,
 *   ellers 6 dage tilbage + i dag
 *
 * Eksempel:
 *   type: custom:elpris-heatmap-card
 *   entity: sensor.elpris_current_price_vat
 *   tomorrow_entity: binary_sensor.elpris_tomorrow_available_vat
 */

const pad2 = (n) => String(n).padStart(2, '0');
const hourKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
const DOW = ['sø', 'ma', 'ti', 'on', 'to', 'fr', 'lø'];

// Farveskala: grøn (billig) -> gul -> rød (dyr)
const COL_LOW = [79, 158, 10];
const COL_MID = [242, 194, 0];
const COL_HIGH = [224, 67, 79];
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

class ElprisHeatmapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hist = new Map();
    this._histDay = null;
    this._histLoading = false;
    this._histFailedAt = 0;
    this._histError = false;
    this._histVersion = 0;
    this._sig = '';
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error('Angiv "entity", fx sensor.elpris_current_price_vat');
    }
    this._config = {
      tomorrow_entity: null,
      total_days: 7,
      decimals: 2,
      decimal_separator: '.',
      row_padding: 5,
      title: null,
      ...config,
    };
    this._sig = '';
    this._histDay = null;
  }

  getCardSize() {
    return 13;
  }

  static getStubConfig() {
    return {
      entity: 'sensor.elpris_current_price_vat',
      tomorrow_entity: 'binary_sensor.elpris_tomorrow_available_vat',
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._maybeLoadHistory();

    const st = hass.states[this._config.entity];
    const tst = this._config.tomorrow_entity ? hass.states[this._config.tomorrow_entity] : null;
    const now = new Date();
    const sig = [
      st && st.last_updated,
      tst && tst.state,
      tst && tst.last_updated,
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      this._histVersion,
    ].join('|');
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
  }

  // ---------- Historik (tidligere dage) ----------

  _maybeLoadHistory() {
    if (!this._hass || this._histLoading) return;
    const t = new Date();
    const dayKey = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    if (this._histDay === dayKey) return;
    if (this._histFailedAt && Date.now() - this._histFailedAt < 5 * 60 * 1000) return;

    this._histLoading = true;
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7);
    const end = new Date();
    const entity = this._config.entity;

    this._hass
      .callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entity],
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: true,
        no_attributes: true,
      })
      .then((res) => {
        const list = (res && res[entity]) || [];
        this._hist = this._bucketHistory(list, end.getTime());
        this._histDay = dayKey;
        this._histError = false;
      })
      .catch((err) => {
        console.warn('elpris-heatmap-card: kunne ikke hente historik', err);
        this._histError = true;
        this._histFailedAt = Date.now();
      })
      .finally(() => {
        this._histLoading = false;
        this._histVersion += 1;
        this._render();
      });
  }

  // Tidsvægtet timegennemsnit ud fra sensorens tilstandsskift
  _bucketHistory(list, endMs) {
    const pts = list
      .map((x) => {
        const ts = x.lu ?? x.lc ?? x.last_updated ?? x.last_changed;
        const t = typeof ts === 'number' ? ts * 1000 : Date.parse(ts);
        const v = parseFloat(String(x.s ?? x.state).replace(',', '.'));
        return { t, v };
      })
      .filter((p) => !isNaN(p.t))
      .sort((a, b) => a.t - b.t);

    const acc = new Map();
    for (let i = 0; i < pts.length; i++) {
      const { t, v } = pts[i];
      if (isNaN(v)) continue;
      const tEnd = i + 1 < pts.length ? pts[i + 1].t : endMs;
      let cur = t;
      while (cur < tEnd) {
        const d = new Date(cur);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const seg = Math.min(next, tEnd);
        const k = hourKey(d);
        const a = acc.get(k) || { s: 0, w: 0 };
        a.s += v * (seg - cur);
        a.w += seg - cur;
        acc.set(k, a);
        cur = seg;
      }
    }
    const out = new Map();
    acc.forEach((a, k) => {
      if (a.w >= 30 * 60 * 1000) out.set(k, a.s / a.w);
    });
    return out;
  }

  // ---------- Attributter (i dag og i morgen) ----------

  _collectPrices(stateObj, acc) {
    let prices = stateObj && stateObj.attributes && stateObj.attributes.prices;
    if (typeof prices === 'string') {
      try {
        prices = JSON.parse(prices);
      } catch (e) {
        prices = null;
      }
    }
    if (!Array.isArray(prices)) return;
    prices.forEach((e) => {
      const ts = e.start ?? e.from ?? e.hour ?? e.time ?? e.date;
      const p = Number(e.price ?? e.value);
      const d = new Date(ts);
      if (isNaN(d.getTime()) || !isFinite(p)) return;
      const k = hourKey(d);
      const a = acc.get(k) || { s: 0, n: 0 };
      a.s += p;
      a.n += 1;
      acc.set(k, a);
    });
  }

  // ---------- Visning ----------

  _render() {
    if (!this._hass || !this._config) return;
    const cfg = this._config;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const tst = cfg.tomorrow_entity ? this._hass.states[cfg.tomorrow_entity] : null;
    const tomorrowOn = !!tst && tst.state === 'on';
    const total = Number(cfg.total_days) || 7;
    const back = Math.max(0, total - 1 - (tomorrowOn ? 1 : 0));

    const days = [];
    for (let i = -back; i <= (tomorrowOn ? 1 : 0); i++) {
      days.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
    }

    const acc = new Map();
    this._collectPrices(this._hass.states[cfg.entity], acc);
    if (tomorrowOn) this._collectPrices(tst, acc);

    const val = (d, h) => {
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${h}`;
      const a = acc.get(k);
      if (a && a.n) return a.s / a.n;
      const hv = this._hist.get(k);
      return hv === undefined ? null : hv;
    };

    const grid = [];
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let h = 0; h < 24; h++) {
      const row = days.map((d) => val(d, h));
      row.forEach((v) => {
        if (v !== null) {
          dMin = Math.min(dMin, v);
          dMax = Math.max(dMax, v);
        }
      });
      grid.push(row);
    }
    const min = cfg.min !== undefined ? Number(cfg.min) : dMin;
    const max = cfg.max !== undefined ? Number(cfg.max) : dMax;
    const mid = cfg.mid !== undefined ? Number(cfg.mid) : (min + max) / 2;

    const colorFor = (v) => {
      const c =
        v <= mid
          ? mix(COL_LOW, COL_MID, mid > min ? clamp01((v - min) / (mid - min)) : 0)
          : mix(COL_MID, COL_HIGH, max > mid ? clamp01((v - mid) / (max - mid)) : 1);
      return `rgb(${c.join(',')})`;
    };
    const fmt = (v) => v.toFixed(cfg.decimals).replace('.', cfg.decimal_separator);

    // Overskrifter
    const monthRow = days
      .map((d, i) => {
        const show = i === 0 || d.getMonth() !== days[i - 1].getMonth();
        return `<th>${show ? `${pad2(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}` : ''}</th>`;
      })
      .join('');
    const dayRow = days
      .map((d) => {
        const isToday = d.getTime() === today.getTime();
        return `<th class="${isToday ? 'today' : ''}">${isToday ? 'I dag' : d.getDate()}</th>`;
      })
      .join('');
    const dowRow = days
      .map((d) => {
        const isToday = d.getTime() === today.getTime();
        return `<th class="${isToday ? 'today' : ''}">${DOW[d.getDay()]}</th>`;
      })
      .join('');

    // Rækker
    const nowHour = now.getHours();
    const body = grid
      .map((row, h) => {
        const cells = row
          .map((v, c) => {
            if (v === null) return '<td class="empty"></td>';
            const isNow = days[c].getTime() === today.getTime() && h === nowHour;
            const tip = `${pad2(days[c].getDate())}/${pad2(days[c].getMonth() + 1)} kl. ${pad2(h)}-${pad2(h + 1)}: ${fmt(v)} kr/kWh`;
            return `<td class="${isNow ? 'now' : ''}" style="background:${colorFor(v)}" title="${tip}">${fmt(v)}</td>`;
          })
          .join('');
        return `<tr><th class="hour">${pad2(h)}-${pad2(h + 1)}</th>${cells}</tr>`;
      })
      .join('');

    let note = '';
    if (this._histError) {
      note = '<div class="note">Historik kunne ikke hentes, så kun i dag og i morgen vises.</div>';
    } else if (this._histLoading && this._histDay === null) {
      note = '<div class="note">Henter historik...</div>';
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 8px 8px 10px; }
        .title { font-size: 1.1em; font-weight: 500; padding: 4px 6px 8px; color: var(--primary-text-color); }
        table {
          width: 100%;
          table-layout: fixed;
          border-collapse: separate;
          border-spacing: 1px;
          font-variant-numeric: tabular-nums;
          color: var(--primary-text-color);
        }
        col.lbl { width: 15%; }
        th { font-weight: 400; text-align: left; padding: 3px 4px 3px 6px; white-space: nowrap; overflow: visible; }
        th.today { font-weight: 600; }
        th.hour { padding: ${cfg.row_padding}px 4px ${cfg.row_padding}px 0; }
        td {
          text-align: center;
          padding: ${cfg.row_padding}px 0;
          color: #202124;
          font-size: 1.05em;
        }
        td.now { color: #fff; font-weight: 600; text-shadow: 0 0 2px rgba(0, 0, 0, 0.55); }
        td.empty { background: var(--secondary-background-color, rgba(127, 127, 127, 0.15)); }
        .note { padding: 6px 6px 0; font-size: 0.85em; color: var(--secondary-text-color); }
      </style>
      <ha-card>
        ${cfg.title ? `<div class="title">${cfg.title}</div>` : ''}
        <table>
          <colgroup><col class="lbl">${days.map(() => '<col>').join('')}</colgroup>
          <thead>
            <tr><th>Md-År</th>${monthRow}</tr>
            <tr><th>Dag</th>${dayRow}</tr>
            <tr><th>Time</th>${dowRow}</tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
        ${note}
      </ha-card>
    `;
  }
}

customElements.define('elpris-heatmap-card', ElprisHeatmapCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'elpris-heatmap-card',
  name: 'Elpris heatmap',
  description: 'Elpriser pr. time de seneste 7 dage som heatmap',
});
