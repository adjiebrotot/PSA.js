// SPDX-License-Identifier: MIT
/**
 * Temporal clustering (mirrors `pypsa.clustering.temporal`): resampling to a
 * coarser fixed frequency, downsampling by stride and aggregation along a
 * user-given snapshot map, and segmentation (tsam's, for one period).
 */

import { Index, compareLabels, labelKey } from "../core/index.js";
import { DataFrame, Series } from "../core/frame.js";
import { logger } from "../logger.js";
import { wardClustering } from "./hac.js";

export const TEMPORAL_AGGREGATION_DEFAULTS = { default: "mean", e_max_pu: "min", e_min_pu: "max" };

function aggregationRule(attr, rules = null) {
  if (rules && attr in rules) return rules[attr];
  return TEMPORAL_AGGREGATION_DEFAULTS[attr] ?? "mean";
}

function agg(xs, rule) {
  const v = xs.filter((x) => !Number.isNaN(x));
  switch (rule) {
    case "mean":
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    case "sum":
      return v.reduce((a, b) => a + b, 0);
    case "min":
      return v.length ? Math.min(...v) : NaN;
    case "max":
      return v.length ? Math.max(...v) : NaN;
    case "first":
      return v.length ? v[0] : NaN;
    case "last":
      return v.length ? v[v.length - 1] : NaN;
    default:
      if (typeof rule === "function") return rule(xs);
      throw new Error(`Unsupported aggregation rule '${rule}'`);
  }
}

// ----------------------------------------------------------------------
// datetime helpers (snapshots are "YYYY-MM-DD HH:MM:SS" strings)
// ----------------------------------------------------------------------

function parseTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s));
  if (!m) throw new TypeError(`resample() requires datetime snapshots, got ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function fmtTs(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const DAY = 864e5;
const WEEKDAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const dayOf = (t) => Math.floor(t / DAY) * DAY; // normalize (UTC midnight)
const ymd = (t) => {
  const d = new Date(t);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
};
const monthStart = (y, m) => Date.UTC(y, m, 1);
const monthEnd = (y, m) => Date.UTC(y, m + 1, 0);

/**
 * pandas offsets: fixed frequencies ("3h", "30min", "D", "2D", "1s") and the
 * calendar anchors weekly ("W", "W-MON", ...), month ("ME", "MS"), quarter
 * ("QE", "QS", "QE-NOV", ...) and year ("YE", "YS", "YE-JUN", ...).
 *
 * A fixed frequency gives `{step}`. An anchor gives `{label(t), next(label)}`:
 * pandas closes (and labels) week, month, quarter and year *ends* on the
 * right, so a timestamp belongs to the first end on or after its day, and
 * *starts* on the left (the last start on or before its day).
 */
function parseOffset(offset) {
  const str = String(offset).trim();
  const tick = /^(\d*)\s*(s|S|min|T|h|H|D|d)$/.exec(str);
  if (tick) {
    const k = tick[1] ? Number(tick[1]) : 1;
    const unit = { s: 1e3, S: 1e3, min: 6e4, T: 6e4, h: 36e5, H: 36e5, D: DAY, d: DAY }[tick[2]];
    return { step: k * unit };
  }
  const m = /^(\d*)(W|ME|MS|QE|QS|YE|YS)(?:-([A-Z]{3}))?$/.exec(str);
  if (!m) throw new Error(`Unsupported resample offset '${offset}' (use multiples of s, min, h or D, or W, ME, MS, QE, QS, YE, YS)`);
  if (m[1] && Number(m[1]) !== 1) throw new Error(`NotImplementedError: multiples of anchored offsets ('${offset}') are not supported`);
  const [, , kind, anchor] = m;
  if (kind === "W") {
    const wd = WEEKDAYS[anchor ?? "SUN"];
    if (wd === undefined) throw new Error(`Invalid weekly anchor '${anchor}'`);
    return { label: (t) => dayOf(t) + (((wd - new Date(t).getUTCDay()) % 7) + 7) % 7 * DAY, next: (a) => a + 7 * DAY };
  }
  if (kind === "ME" || kind === "MS") {
    if (anchor) throw new Error(`Invalid offset '${offset}'`);
    if (kind === "ME") return { label: (t) => monthEnd(...ymd(t).slice(0, 2)), next: (a) => monthEnd(ymd(a)[0], ymd(a)[1] + 1) };
    return { label: (t) => monthStart(...ymd(t).slice(0, 2)), next: (a) => monthStart(ymd(a)[0], ymd(a)[1] + 1) };
  }
  // quarters and years, anchored on a month (default DEC for ends, JAN for starts)
  const end = kind.endsWith("E");
  const am = MONTHS[anchor ?? (end ? "DEC" : "JAN")];
  if (am === undefined) throw new Error(`Invalid anchor '${anchor}'`);
  const months = kind[0] === "Q" ? 3 : 12;
  const shift = (y, mo, k) => [y + Math.floor((mo + k) / 12), (((mo + k) % 12) + 12) % 12];
  if (end) {
    const label = (t) => {
      const [y, mo] = ymd(t);
      const k = (((am - mo) % months) + months) % months; // months to the next anchor month
      return monthEnd(...shift(y, mo, k));
    };
    return { label, next: (a) => monthEnd(...shift(ymd(a)[0], ymd(a)[1], months)) };
  }
  const label = (t) => {
    const [y, mo] = ymd(t);
    const k = (((mo - am) % months) + months) % months; // months since the last anchor month
    return monthStart(...shift(y, mo, -k));
  };
  return { label, next: (a) => monthStart(...shift(ymd(a)[0], ymd(a)[1], months)) };
}

/**
 * Resample bins of the given timestamps (fixed frequencies: label=left,
 * closed=left, origin start of the first day; calendar anchors as pandas);
 * returns the bin label (ms) per timestamp and all bins from the first to the
 * last one.
 */
function binTimestamps(times, offset) {
  const off = parseOffset(offset);
  const first = times[0];
  if (off.step === undefined) {
    const bins = [];
    const last = off.label(times[times.length - 1]);
    for (let b = off.label(first); b <= last; b = off.next(b)) bins.push(b);
    return { binOf: off.label, bins };
  }
  const { step } = off;
  const day = dayOf(first);
  const binOf = (t) => day + Math.floor((t - day) / step) * step;
  const bins = [];
  const last = binOf(times[times.length - 1]);
  for (let b = binOf(first); b <= last; b += step) bins.push(b);
  return { binOf, bins };
}

function isLeapDay(ms) {
  const d = new Date(ms);
  return d.getUTCMonth() === 1 && d.getUTCDate() === 29;
}

export class TemporalClustering {
  constructor(n, snapshot_map) {
    this.n = n;
    this.snapshot_map = snapshot_map;
    enforcePuBounds(n);
  }
}

function enforcePuBounds(n) {
  for (const c of n.components.values()) {
    for (const minAttr of Object.keys(c.dynamic).filter((a) => a.endsWith("_min_pu"))) {
      const maxAttr = minAttr.replace("_min_pu", "_max_pu");
      const maxDf = c.dynamic[maxAttr];
      if (!maxDf) continue;
      const minDf = c.dynamic[minAttr];
      for (const col of minDf.columns) {
        if (!maxDf.has(col)) continue;
        const a = minDf.col(col);
        const b = maxDf.col(col);
        for (let i = 0; i < a.length; i++) if (a[i] > b[i]) a[i] = b[i];
      }
    }
  }
}

function warnIfSolved(n) {
  const solved = [...n.components.values()].some((c) => c.dynamic.p && c.dynamic.p.columns.length && c.dynamic.p.index.length);
  if (solved) logger.warning("Applying temporal clustering to a solved network may result in inconsistent storage state of charge and dispatch values.");
}

/** Group rows of a snapshot-indexed frame into the given groups (row indices). */
function aggregateRows(df, groups, rule) {
  const out = new DataFrame({ index: new Index(groups.map((g) => g.label), "snapshot") });
  for (const col of df.columns) {
    const a = df.col(col);
    out.set(
      col,
      Float64Array.from(groups, (g) => agg(g.rows.map((i) => a[i]), rule)),
    );
  }
  return out;
}

function setResult(n, m, snapshotsIndex, weightings, groups, aggregation_rules) {
  m.set_snapshots(snapshotsIndex);
  m.snapshot_weightings = weightings;
  for (const c of n.components.values()) {
    if (c.static.empty) continue;
    for (const [attr, df] of Object.entries(c.dynamic)) {
      if (df.columns.length === 0 || df.index.length === 0) continue;
      const res = aggregateRows(df, groups, aggregationRule(attr, aggregation_rules));
      res.index = snapshotsIndex;
      m._import_series_from_df(res, c.name, attr, true);
    }
  }
}

/** Resample to a coarser fixed frequency (`offset`, e.g. "3h" or "D"). */
export function resample(n, offset, { drop_leap_day = false, aggregation_rules = null } = {}) {
  warnIfSolved(n);
  const sns = n.snapshots;
  const multi = sns.isMulti;
  const w = n.snapshot_weightings;
  const m = n.copy();
  // partitions: years (single index) or investment periods
  const parts = new Map();
  sns.values.forEach((s, i) => {
    const t = parseTs(multi ? s[1] : s);
    const key = multi ? s[0] : new Date(t).getUTCFullYear();
    if (!parts.has(key)) parts.set(key, []);
    parts.get(key).push([i, t]);
  });
  const groups = [];
  const snapshotMap = new Array(sns.length);
  for (const [key, rows] of parts) {
    const times = rows.map(([, t]) => t);
    const { binOf, bins } = binTimestamps(times, offset);
    const members = new Map(bins.map((b) => [b, []]));
    rows.forEach(([i, t]) => members.get(binOf(t)).push(i));
    let partGroups = bins.map((b) => ({ ms: b, rows: members.get(b) })).filter((g) => {
      // query("objective != 0")
      let s = 0;
      for (const i of g.rows) s += w.col("objective")[i];
      return s !== 0;
    });
    if (drop_leap_day) {
      const leap = partGroups.filter((g) => isLeapDay(g.ms));
      for (const lg of leap) {
        const d = new Date(lg.ms);
        const march = partGroups.find((g) => {
          const e = new Date(g.ms);
          return e.getUTCFullYear() === d.getUTCFullYear() && e.getUTCMonth() === 2 && e.getUTCDate() === 1;
        });
        if (march) march.extraWeights = [...(march.extraWeights ?? []), ...lg.rows];
      }
      partGroups = partGroups.filter((g) => !isLeapDay(g.ms));
    }
    for (const g of partGroups) {
      g.label = multi ? [key, fmtTs(g.ms)] : fmtTs(g.ms);
      groups.push(g);
    }
    // snapshot map: searchsorted(new bins, t, side=right) - 1, clipped
    const newBins = partGroups.map((g) => g.ms);
    rows.forEach(([i, t]) => {
      let k = 0;
      while (k + 1 < newBins.length && newBins[k + 1] <= t) k++;
      snapshotMap[i] = multi ? [key, fmtTs(newBins[k])] : fmtTs(newBins[k]);
    });
  }
  const index = multi ? new Index(groups.map((g) => g.label), ["period", "timestep"]) : new Index(groups.map((g) => g.label), "snapshot");
  const weightings = new DataFrame({ index });
  for (const col of w.columns) {
    const a = w.col(col);
    weightings.set(
      col,
      Float64Array.from(groups, (g) => [...g.rows, ...(g.extraWeights ?? [])].reduce((s, i) => s + a[i], 0)),
    );
  }
  // time series aggregated over the bin members (leap-day bins are dropped)
  setResult(n, m, index, weightings, groups, aggregation_rules);
  return new TemporalClustering(m, new Series(snapshotMap, sns));
}

/** Keep every `stride`-th snapshot and scale the weightings. */
export function downsample(n, stride) {
  warnIfSolved(n);
  if (stride < 1) throw new Error(`stride must be >= 1, got ${stride}`);
  const sns = n.snapshots;
  const multi = sns.isMulti;
  const w = n.snapshot_weightings;
  const m = n.copy();
  const parts = new Map();
  sns.values.forEach((s, i) => {
    const key = multi ? s[0] : 0;
    if (!parts.has(key)) parts.set(key, []);
    parts.get(key).push(i);
  });
  const selected = [];
  const factors = [];
  const snapshotMap = new Array(sns.length);
  for (const rows of parts.values()) {
    const sel = [];
    for (let k = 0; k < rows.length; k += stride) sel.push(rows[k]);
    const rem = rows.length % stride;
    sel.forEach((i, k) => {
      selected.push(i);
      factors.push(k === sel.length - 1 && rem !== 0 ? rem : stride);
    });
    rows.forEach((i, k) => {
      snapshotMap[i] = sns.at(sel[Math.min(Math.floor(k / stride), sel.length - 1)]);
    });
  }
  const index = new Index(
    selected.map((i) => sns.at(i)),
    multi ? sns.names : sns.name,
  );
  const weightings = new DataFrame({ index });
  for (const col of w.columns) {
    const a = w.col(col);
    weightings.set(
      col,
      Float64Array.from(selected, (i, k) => (factors[k] === stride ? a[i] * stride : (a[i] * stride) / stride * factors[k])),
    );
  }
  m.set_snapshots(index);
  m.snapshot_weightings = weightings;
  for (const c of n.components.values()) {
    if (c.static.empty) continue;
    for (const [attr, df] of Object.entries(c.dynamic)) {
      if (df.columns.length === 0 || df.index.length === 0) continue;
      const res = new DataFrame({ index });
      for (const col of df.columns) res.set(col, Float64Array.from(selected, (i) => df.col(col)[i]));
      m._import_series_from_df(res, c.name, attr, true);
    }
  }
  return new TemporalClustering(m, new Series(snapshotMap, sns));
}

/** Aggregate snapshots along a map (snapshot -> representative snapshot). */
export function from_snapshot_map(n, snapshot_map, { aggregation_rules = null } = {}) {
  warnIfSolved(n);
  const map = snapshot_map instanceof DataFrame ? snapshot_map.series(snapshot_map.columns.at(0)) : snapshot_map;
  if (!map.index.equals(n.snapshots)) throw new Error("snapshot_map index must match network snapshots");
  const targets = [...new Map(Array.from(map.values, (v) => [labelKey(v), v])).values()].sort(compareLabels);
  const pos = new Map(targets.map((t, i) => [labelKey(t), i]));
  const groups = targets.map((t) => ({ label: t, rows: [] }));
  Array.from(map.values).forEach((v, i) => groups[pos.get(labelKey(v))].rows.push(i));
  const sns = n.snapshots;
  const index = new Index(targets, sns.isMulti ? sns.names : sns.name);
  const w = n.snapshot_weightings;
  const weightings = new DataFrame({ index });
  for (const col of w.columns) {
    const a = w.col(col);
    weightings.set(
      col,
      Float64Array.from(groups, (g) => g.rows.reduce((s, i) => s + a[i], 0)),
    );
  }
  const m = n.copy();
  setResult(n, m, index, weightings, groups, aggregation_rules);
  return new TemporalClustering(m, map);
}

/**
 * Segmentation into `num_segments` periods of adjacent snapshots with similar
 * time series (mirrors PyPSA's `segment`, which runs tsam with one typical
 * period): the time series, scaled by their maxima, are min-max normalised
 * and clustered by Ward linkage restricted to neighbouring snapshots; each
 * segment takes the mean of its snapshots and is weighted by its length.
 *
 * Like PyPSA (tsam's `period_duration` is in hours) only hourly or
 * non-datetime snapshots form a single period; other resolutions raise.
 */
export function segment(n, num_segments, { exclude_attrs = null, aggregation_rules = null } = {}) {
  void aggregation_rules;
  warnIfSolved(n);
  if (n.has_scenarios) throw new Error("NotImplementedError: Temporal clustering is not yet supported for stochastic networks.");
  if (!(num_segments >= 1)) throw new Error(`ValueError: num_segments must be >= 1, got ${num_segments}`);
  const sns = n.snapshots;
  if (num_segments > sns.length) throw new Error(`ValueError: num_segments (${num_segments}) cannot exceed number of snapshots (${sns.length})`);
  if (n.has_periods) throw new Error("NotImplementedError: segment() does not yet support networks with investment periods");
  const datetimes = sns.values.every((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s));
  if (datetimes && sns.length > 1 && parseTs(sns.at(1)) - parseTs(sns.at(0)) !== 36e5) {
    throw new Error("NotImplementedError: segment() needs hourly (or non-datetime) snapshots: PyPSA passes the snapshot count to tsam as hours, so other resolutions segment only part of the series.");
  }
  exclude_attrs = exclude_attrs ?? ["e_min_pu"];

  // time series columns (component, attribute, name)
  const cols = [];
  for (const c of n.components.values()) {
    if (c.static.empty || c.static.index.length === 0) continue;
    for (const [attr, df] of Object.entries(c.dynamic)) {
      if (df.columns.length === 0 || df.index.length === 0 || exclude_attrs.includes(attr)) continue;
      for (const col of df.columns) cols.push({ c, attr, col, values: Array.from(df.col(col)) });
    }
  }
  if (!cols.length) throw new Error("ValueError: No time-varying data found for segmentation");
  const T = sns.length;
  const K = cols.length;
  // scaled by the column maxima (0 -> 1), NaN -> 0
  const factor = cols.map(({ values }) => {
    const v = values.filter((x) => !Number.isNaN(x));
    const mx = v.length ? Math.max(...v) : NaN;
    return mx === 0 ? 1 : mx;
  });
  const scaled = Array.from({ length: T }, (_, t) =>
    cols.map(({ values }, k) => {
      const x = values[t] / factor[k];
      return Number.isNaN(x) ? 0 : x;
    }),
  );
  // tsam: sklearn MinMaxScaler to [0, 1]
  const EPS10 = 10 * Number.EPSILON;
  const lo = cols.map((_, k) => Math.min(...scaled.map((r) => r[k])));
  const scale = cols.map((_, k) => {
    const range = Math.max(...scaled.map((r) => r[k])) - lo[k];
    return 1 / (range < EPS10 ? 1 : range);
  });
  const shift = lo.map((m, k) => 0 - m * scale[k]);
  const X = scaled.map((r) => r.map((x, k) => x * scale[k] + shift[k]));

  // Ward clustering of neighbouring snapshots, segments relabelled in time order
  let labels;
  if (num_segments === 1) labels = new Array(T).fill(0);
  else {
    const raw = wardClustering(
      X,
      Array.from({ length: T - 1 }, (_, t) => [t, t + 1]),
      num_segments,
    );
    const order = new Map();
    for (const l of raw) if (!order.has(l)) order.set(l, order.size);
    labels = Array.from(raw, (l) => order.get(l));
  }
  const durations = new Array(num_segments).fill(0);
  for (const l of labels) durations[l]++;
  const offsets = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));
  // segment means, back to the original units
  const values = durations.map((d, sIdx) => {
    const sum = new Float64Array(K);
    for (let t = offsets[sIdx]; t < offsets[sIdx] + d; t++) for (let k = 0; k < K; k++) sum[k] += X[t][k];
    return Array.from(sum, (x, k) => ((x / d - shift[k]) / scale[k]) * factor[k]);
  });

  const index = new Index(
    offsets.map((o) => sns.at(o)),
    sns.name ?? "snapshot",
  );
  const m = n.copy();
  m.set_snapshots(index);
  const w = new DataFrame({ index });
  for (const col of n.snapshot_weightings.columns) w.set(col, Float64Array.from(durations));
  m.snapshot_weightings = w;
  cols.forEach(({ c, attr, col }, k) => {
    const dst = m.c.get(c.name);
    const df = dst.dynamic[attr];
    const series = Float64Array.from(values, (v) => v[k]);
    if (df && df.columns.length && df.index.length) df.set(col, series);
    else {
      const frame = new DataFrame({ index, columns: [col], data: new Map([[col, series]]) });
      m._import_series_from_df(frame, c.name, attr, true);
    }
  });
  const map = new Series(
    labels.map((l) => index.at(l)),
    sns,
  );
  return new TemporalClustering(m, map);
}

/** Temporal clustering accessor (`n.cluster.temporal`). */
export class TemporalClusteringAccessor {
  constructor(n) {
    this._n = n;
  }

  /**
   * The network resampled to a coarser frequency (`3h`, `D`, `W`, `ME`, `QS`, ...), weightings summed.
   */
  resample(offset, opts = {}) {
    return resample(this._n, offset, opts).n;
  }

  /** `TemporalClustering` result of `resample` (network and snapshot map). */
  get_resample_result(offset, opts = {}) {
    return resample(this._n, offset, opts);
  }

  /** The network with every `stride`-th snapshot, weightings scaled. */
  downsample(stride) {
    return downsample(this._n, stride).n;
  }

  /** `TemporalClustering` result of `downsample`. */
  get_downsample_result(stride) {
    return downsample(this._n, stride);
  }

  /** The network aggregated along a snapshot map (snapshot -> representative snapshot). */
  from_snapshot_map(snapshot_map, opts = {}) {
    return from_snapshot_map(this._n, snapshot_map, opts).n;
  }

  /** `TemporalClustering` result of `from_snapshot_map`. */
  get_from_snapshot_map_result(snapshot_map, opts = {}) {
    return from_snapshot_map(this._n, snapshot_map, opts);
  }

  /**
   * The network reduced to `num_segments` segments of adjacent similar snapshots (tsam's segmentation).
   */
  segment(num_segments, opts = {}) {
    return segment(this._n, num_segments, opts).n;
  }

  /** `TemporalClustering` result of `segment`. */
  get_segment_result(num_segments, opts = {}) {
    return segment(this._n, num_segments, opts);
  }
}
