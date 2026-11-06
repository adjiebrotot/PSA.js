// SPDX-License-Identifier: MIT
/**
 * Import of pandapower networks (mirrors `import_from_pandapower_net` of
 * `pypsa.network.io`). A pandapower net is a Python object, so PSA.js reads
 * the JSON that `pandapower.to_json(net)` writes (a path, the JSON text or
 * the parsed object): every table is a pandas DataFrame in `orient="split"`
 * form with its dtypes.
 */

import { Network } from "./network.js";
import { logger } from "../logger.js";
import { pyFloatRepr } from "../core/csv.js";

const fs = globalThis.process?.getBuiltinModule?.("node:fs") ?? null;

/** The net's tables and scalars from `pp.to_json` output. */
function netObject(net) {
  if (typeof net === "string") {
    const text = net.trimStart().startsWith("{") ? net : readText(net);
    net = JSON.parse(text);
  }
  return net && net._class === "pandapowerNet" ? net._object : net;
}

function readText(path) {
  if (!fs) throw new Error("Reading files needs Node.js; pass the pandapower JSON instead");
  return fs.readFileSync(path, "utf8");
}

const isNull = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

/** A pandapower table: index labels, columns by name and pandas dtypes. */
function table(net, key) {
  const t = net[key];
  if (!t) return { index: [], col: () => [], dtype: () => "object", length: 0 };
  const obj = typeof t._object === "string" ? JSON.parse(t._object) : t._object;
  const columns = new Map((obj.columns ?? []).map((c, j) => [c, j]));
  const data = obj.data ?? [];
  const dtypes = t.dtype ?? {};
  return {
    index: obj.index ?? [],
    length: (obj.index ?? []).length,
    col(name) {
      const j = columns.get(name);
      const float = String(dtypes[name] ?? "").startsWith("float");
      // JSON nulls are NaN in float columns and None elsewhere
      return data.map((row) => (j === undefined ? NaN : row[j] === null ? (float ? NaN : null) : row[j]));
    },
    dtype: (name) => String(dtypes[name] ?? "object"),
  };
}

/** `pd.Index(values).astype(str)`. */
function strLabel(v, dtype) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    return dtype.startsWith("float") ? pyFloatRepr(v) : String(v);
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

const num = (v) => (isNull(v) ? NaN : Number(v));

Object.assign(Network.prototype, {
  /**
   * Import a pandapower network from the JSON written by `pandapower.to_json`
   * (path, text or parsed object). Like PyPSA, three-winding transformers,
   * in-service flags and tap positions are ignored and buses joined by
   * closed bus-bus switches are merged.
   */
  import_from_pandapower_net(net, { extra_line_data = false, use_pandapower_index = false } = {}) {
    logger.warning(
      "Warning: Importing from pandapower is still in beta; not all pandapower data is supported.\nUnsupported features include: three-winding transformers, switches, in_service status, shunt impedances and tap positions of transformers.",
    );
    const o = netObject(net);
    const bus = table(o, "bus");
    const busNames = bus.col("name");
    const nameOf = new Map(bus.index.map((ix, i) => [ix, busNames[i]]));
    const busesOf = (t, column) => t.col(column).map((b) => nameOf.get(b));
    const labels = (t, values = t.col("name")) => values.map((v) => strLabel(v, t.dtype("name")));
    const busLabels = (values) => values.map((v) => strLabel(v, bus.dtype("name")));

    // Bus: v_mag_pu_set from PV generators and external grids (`.loc` by name)
    const vnKv = bus.col("vn_kv").map(num);
    const vmag = new Array(bus.length).fill(1.0);
    const setByName = (names, values) => {
      names.forEach((nm, k) => {
        busNames.forEach((b, i) => {
          if (b === nm) vmag[i] = num(values[k]);
        });
      });
    };
    const gen = table(o, "gen");
    const extGrid = table(o, "ext_grid");
    setByName(busesOf(gen, "bus"), gen.col("vm_pu"));
    setByName(busesOf(extGrid, "bus"), extGrid.col("vm_pu"));

    const load = table(o, "load");
    const scaled = (t, column) => t.col("scaling").map((s, i) => num(s) * num(t.col(column)[i]));
    const sgen = table(o, "sgen");

    // generators: PV generators, PQ static generators and the external grids (slack)
    const extNames = extGrid.col("name").map((v) => (isNull(v) ? "External Grid" : v));
    let genNames = [...labels(gen), ...labels(sgen), ...labels(extGrid, extNames)];
    if (use_pandapower_index) genNames = genNames.map((_, i) => String(i));
    const generators = {
      p_set: [...scaled(gen, "p_mw"), ...scaled(sgen, "p_mw"), ...extGrid.index.map(() => 0.0)],
      q_set: [...gen.index.map(() => 0.0), ...scaled(sgen, "q_mvar"), ...extGrid.index.map(() => 0.0)],
      bus: busLabels([...busesOf(gen, "bus"), ...busesOf(sgen, "bus"), ...busesOf(extGrid, "bus")]),
      control: [...gen.index.map(() => "PV"), ...sgen.index.map(() => "PQ"), ...extGrid.index.map(() => "Slack")],
    };

    const line = table(o, "line");
    const length = line.col("length_km").map(num);
    let lines;
    if (!extra_line_data) {
      lines = { type: line.col("std_type"), bus0: busLabels(busesOf(line, "from_bus")), bus1: busLabels(busesOf(line, "to_bus")), length, num_parallel: line.col("parallel").map(num) };
    } else {
      const f = num(o.f_hz);
      const vOf = new Map(bus.index.map((ix, i) => [ix, vnKv[i]]));
      const fromBus = line.col("from_bus");
      const maxI = line.col("max_i_ka").map(num);
      lines = {
        r: line.col("r_ohm_per_km").map((r, i) => num(r) * length[i]),
        x: line.col("x_ohm_per_km").map((x, i) => num(x) * length[i]),
        // capacitance in nF
        b: line.col("c_nf_per_km").map((c, i) => num(c) * length[i] * 1e-9 * 2 * Math.PI * f),
        s_nom: fromBus.map((b, i) => vOf.get(b) * maxI[i]),
        bus0: busLabels(busesOf(line, "from_bus")),
        bus1: busLabels(busesOf(line, "to_bus")),
        length,
        num_parallel: line.col("parallel").map(num),
      };
    }

    // transformers: standard types if any is given, otherwise impedances
    const trafo = table(o, "trafo");
    const stdTypes = trafo.col("std_type");
    let trafos;
    if (stdTypes.some((t) => !isNull(t) && t !== "" && t !== false && t !== 0)) {
      trafos = { type: stdTypes, bus0: busLabels(busesOf(trafo, "hv_bus")), bus1: busLabels(busesOf(trafo, "lv_bus")), tap_position: trafo.col("tap_pos").map(num) };
    } else {
      const sn = trafo.col("sn_mva").map(num);
      const z = trafo.col("vk_percent").map((v, i) => num(v) / 100.0 / sn[i]);
      const r = trafo.col("vkr_percent").map((v, i) => num(v) / 100.0 / sn[i]);
      const y = trafo.col("i0_percent").map((v) => num(v) / 100.0);
      const g = trafo.col("pfe_kw").map((v, i) => num(v) / sn[i] / 1000 / sn[i]);
      trafos = {
        phase_shift: trafo.col("shift_degree").map(num),
        s_nom: sn,
        bus0: busLabels(busesOf(trafo, "hv_bus")),
        bus1: busLabels(busesOf(trafo, "lv_bus")),
        r,
        x: z.map((zi, i) => Math.sqrt(zi * zi - r[i] * r[i])),
        g,
        b: y.map((yi, i) => Math.sqrt(yi * yi - g[i] * g[i])),
        tap_position: trafo.col("tap_pos").map(num),
      };
    }
    // `.fillna(0)`
    const fill0 = (frame) => Object.fromEntries(Object.entries(frame).map(([k, v]) => [k, v.map((x) => (isNull(x) ? 0 : x))]));
    trafos = fill0(trafos);

    const shunt = table(o, "shunt");
    const vnShunt = shunt.col("vn_kv").map(num);
    const shunts = fill0({
      bus: busLabels(busesOf(shunt, "bus")),
      g: shunt.col("p_mw").map((p, i) => num(p) / (vnShunt[i] * vnShunt[i])),
      b: shunt.col("q_mvar").map((q, i) => -num(q) / (vnShunt[i] * vnShunt[i])),
    });

    const frames = [
      ["Bus", busLabels(busNames), { v_nom: vnKv, v_mag_pu_set: vmag }],
      ["Load", labels(load), { p_set: scaled(load, "p_mw"), q_set: scaled(load, "q_mvar"), bus: busLabels(busesOf(load, "bus")) }],
      ["Generator", genNames, generators],
      ["Line", labels(line), lines],
      ["Transformer", labels(trafo), trafos],
      ["ShuntImpedance", labels(shunt), shunts],
    ];
    for (const [component, names, attrs] of frames) {
      // empty pandapower tables add nothing
      if (!names.length) continue;
      this.add(component, names, attrs);
    }

    // amalgamate buses connected by closed bus-bus switches
    const sw = table(o, "switch");
    const et = sw.col("et");
    const closed = sw.col("closed");
    const swBus = sw.col("bus");
    const element = sw.col("element");
    const replace = new Map();
    const goes = [];
    et.forEach((e, i) => {
      if (e !== "b" || !closed[i]) return;
      const g = nameOf.get(element[i]);
      goes.push(g);
      replace.set(strLabel(g, bus.dtype("name")), strLabel(nameOf.get(swBus[i]), bus.dtype("name")));
    });
    for (const g of goes) this.remove("Bus", strLabel(g, bus.dtype("name")));
    const swap = (c, column) => {
      if (c.static.empty || !c.static.has(column)) return;
      c.static.set(
        column,
        Array.from(c.static.col(column), (v) => (replace.has(v) ? replace.get(v) : v)),
      );
    };
    for (const name of ["Generator", "Load", "ShuntImpedance"]) swap(this.c.get(name), "bus");
    for (const name of ["Line", "Transformer"]) {
      swap(this.c.get(name), "bus0");
      swap(this.c.get(name), "bus1");
    }
    return this;
  },
});
