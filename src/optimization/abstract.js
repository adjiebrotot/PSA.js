// SPDX-License-Identifier: MIT
/**
 * Optimisation workflows built on top of `n.optimize` (mirrors
 * `pypsa.optimization.abstract`): iterative transmission expansion, security
 * constrained optimisation, rolling horizon and optimisation followed by a
 * non-linear power flow.
 */

import { Index } from "../core/index.js";
import { logger } from "../logger.js";
import { as_index } from "../common.js";
import { NOMINAL_ATTRS, npSum } from "./common.js";

/** Python float modulo (result has the sign of the divisor). */
function pyMod(a, b) {
  let mod = a % b;
  if (mod !== 0 && b < 0 !== mod < 0) mod += b;
  return mod;
}

/** Python float floor division (`a // b`). */
function pyFloorDiv(a, b) {
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && b < 0 !== mod < 0) div -= 1;
  if (div === 0) return 0 * (a / b) < 0 ? -0 : 0;
  let floordiv = Math.floor(div);
  if (div - floordiv > 0.5) floordiv += 1;
  return floordiv;
}

/**
 * Discretise an optimised capacity into blocks of `unit_size`.
 * @returns {number}
 */
export function discretized_capacity(nom_opt, nom_max, unit_size, threshold, fractional_last_unit_size) {
  const units = pyFloorDiv(nom_opt, unit_size) + (pyMod(nom_opt, unit_size) >= threshold * unit_size ? 1 : 0);
  const block_capacity = units * unit_size;
  if (pyMod(nom_max, unit_size) === 0) return block_capacity;
  if (nom_max - nom_opt < unit_size) {
    if (fractional_last_unit_size && pyMod(nom_opt, unit_size) / pyMod(nom_max, unit_size) >= threshold) return nom_max;
    if (nom_max < unit_size) return nom_max;
    return pyFloorDiv(nom_opt, unit_size) * unit_size;
  }
  return block_capacity;
}

function mapCol(n, st, col, target, attr) {
  const t = n.c.get(target).static;
  return st.col(col).map((k) => {
    const i = t.index.getLoc(k);
    return i < 0 ? NaN : t.col(attr)[i];
  });
}

function indexWhere(st, pred) {
  return st.index.filter(st.index.values.map((_, i) => pred(i)));
}

/** Install the workflow methods on the optimisation accessor. */
export function installAbstract(Accessor) {
  const proto = Accessor.prototype;

  /**
   * Iterative linear optimisation updating line impedances according to the
   * expanded capacities (Hagspiel et al.), followed by a final run with fixed
   * (optionally discretised) branch capacities.
   */
  proto.optimize_transmission_expansion_iteratively = async function optimizeTransmissionExpansionIteratively(opts = {}) {
    const {
      snapshots = null,
      msq_threshold = 0.05,
      min_iterations = 1,
      max_iterations = 100,
      track_iterations = false,
      line_unit_size = null,
      link_unit_size = null,
      line_threshold = null,
      link_threshold: linkThresholdIn = null,
      fractional_last_unit_size = false,
      ...kwargs
    } = opts;
    const n = this._n;
    const lines = () => n.c.lines.static;
    lines().set("carrier", mapCol(n, lines(), "bus0", "Bus", "carrier"));
    const extI = n.c.lines.extendables.intersection(n.c.lines.active_assets);
    const typedI = indexWhere(lines(), (i) => lines().col("type")[i] !== "");
    const extUntypedI = extI.difference(typedI);
    const extTypedI = extI.intersection(typedI);
    const iNom = mapCol(n, lines(), "type", "LineType", "i_nom");
    const vNom = mapCol(n, lines(), "bus0", "Bus", "v_nom");
    const baseSNom = iNom.map((x, i) => Math.sqrt(3) * x * vNom[i]);
    const baseOf = (nm) => baseSNom[lines().index.getLoc(nm)];
    for (const nm of extTypedI) lines().setAt(nm, "num_parallel", lines().at(nm, "s_nom") / baseOf(nm));

    const updateLineParams = (sNomPrev) => {
      const st = lines();
      for (const [attr, carrier] of [
        ["x", "AC"],
        ["r", "DC"],
      ]) {
        const lnI = indexWhere(st, (i) => st.col("carrier")[i] === carrier).intersection(extUntypedI);
        for (const nm of lnI) {
          const i = st.index.getLoc(nm);
          const factor = st.col("s_nom_opt")[i] / sNomPrev[i];
          st.setAt(nm, attr, st.at(nm, attr) / factor);
        }
      }
      for (const nm of extI.intersection(typedI)) st.setAt(nm, "num_parallel", st.at(nm, "s_nom_opt") / baseOf(nm));
    };

    let iteration = 1;
    const msqDiff = (sNomPrev) => {
      const opt = Array.from(lines().col("s_nom_opt"));
      const sq = opt.map((v, i) => (sNomPrev[i] - v) ** 2).filter((v) => !Number.isNaN(v));
      const valid = opt.filter((v) => !Number.isNaN(v));
      const err = Math.sqrt(sq.reduce((a, b) => a + b, 0) / sq.length) / (valid.reduce((a, b) => a + b, 0) / valid.length);
      logger.info(`Mean square difference after iteration ${iteration} is ${err}`);
      return err;
    };

    const branchNominal = () => Object.entries(NOMINAL_ATTRS).filter(([c]) => n.branch_components.has(c));
    const saveOptimalCapacities = (it, status) => {
      for (const [c, attr] of branchNominal()) {
        const st = n.c.get(c).static;
        st.set(`${attr}_opt_${it}`, Array.from(st.col(`${attr}_opt`)));
      }
      n[`status_${it}`] = status;
      n[`objective_${it}`] = n.objective;
      n.iteration = it;
      const gc = n.c.global_constraints.static;
      if (gc.has("mu")) n.c.global_constraints.static = gc.renameColumns({ mu: `mu_${it}` });
    };

    const linkThreshold = linkThresholdIn ?? {};
    if (track_iterations) {
      for (const [c, attr] of branchNominal()) {
        const st = n.c.get(c).static;
        st.set(`${attr}_opt_0`, Array.from(st.col(attr)));
      }
    }

    let diff = msq_threshold;
    while (diff >= msq_threshold || iteration < min_iterations) {
      if (iteration > max_iterations) {
        logger.info(`Iteration ${iteration} beyond max_iterations ${max_iterations}. Stopping ...`);
        break;
      }
      const sNomPrev = Float64Array.from(lines().col(iteration > 1 ? "s_nom_opt" : "s_nom"));
      const [status, condition] = await n.optimize({ snapshots, ...kwargs });
      if (status !== "ok") throw new Error(`Optimization failed with status ${status} and termination ${condition}`);
      if (track_iterations) saveOptimalCapacities(iteration, status);
      updateLineParams(sNomPrev);
      diff = msqDiff(sNomPrev);
      iteration += 1;
    }

    n._model = null;
    logger.info("Preparing final iteration with fixed and potentially discretized branches (HVDC links and HVAC lines).");
    const linkCarriers = new Set(["DC", ...Object.keys(link_unit_size ?? {})]);
    const links = n.c.links.static;
    const fixLinks = indexWhere(links, (i) => Boolean(links.col("p_nom_extendable")[i]) && linkCarriers.has(links.col("carrier")[i]));
    const sNomOrig = Float64Array.from(lines().col("s_nom"));
    const pNomOrig = Float64Array.from(links.col("p_nom"));
    for (const nm of extI) {
      lines().setAt(nm, "s_nom", lines().at(nm, "s_nom_opt"));
      lines().setAt(nm, "s_nom_extendable", false);
    }
    for (const nm of fixLinks) {
      links.setAt(nm, "p_nom", links.at(nm, "p_nom_opt"));
      links.setAt(nm, "p_nom_extendable", false);
    }

    if (line_unit_size) {
      const st = lines();
      st.set(
        "s_nom",
        st.index.values.map((_, i) =>
          discretized_capacity(st.col("s_nom_opt")[i], st.col("s_nom_max")[i], line_unit_size, line_threshold || 0.3, fractional_last_unit_size),
        ),
      );
    }
    if (link_unit_size) {
      const carriers = new Set(links.col("carrier"));
      for (const carrier of Object.keys(link_unit_size)) {
        if (!carriers.has(carrier)) continue;
        links.index.values.forEach((nm, i) => {
          if (links.col("carrier")[i] !== carrier) return;
          links.setAt(
            nm,
            "p_nom",
            discretized_capacity(links.col("p_nom_opt")[i], links.col("p_nom_max")[i], link_unit_size[carrier], linkThreshold[carrier] ?? 0.3, fractional_last_unit_size),
          );
        });
      }
    }

    n.calculate_dependent_values();
    const [status, condition] = await n.optimize({ snapshots, ...kwargs });

    for (const nm of extI) {
      lines().setAt(nm, "s_nom", sNomOrig[lines().index.getLoc(nm)]);
      lines().setAt(nm, "s_nom_extendable", true);
    }
    for (const nm of fixLinks) {
      links.setAt(nm, "p_nom", pNomOrig[links.index.getLoc(nm)]);
      links.setAt(nm, "p_nom_extendable", true);
    }

    // pandas `.sum()` (skipna) of periodized cost times added capacity
    const pcLinks = n.c.links.periodized_cost;
    const fixLinkSet = new Set(fixLinks.values);
    const linkTerms = [];
    links.index.values.forEach((nm, i) => {
      const v = pcLinks[i] * (links.col("p_nom_opt")[i] - links.col("p_nom_min")[i]);
      if (fixLinkSet.has(nm) && !Number.isNaN(v)) linkTerms.push(v);
    });
    const objLinks = npSum(linkTerms);
    const ls = lines();
    const pcLines = n.c.lines.periodized_cost;
    const objLines = npSum(ls.index.values.map((_, i) => pcLines[i] * (ls.col("s_nom_opt")[i] - ls.col("s_nom_min")[i])).filter((v) => !Number.isNaN(v)));
    n._objective += objLinks + objLines;
    n._objective_constant -= objLinks + objLines;
    return [status, condition];
  };

  /**
   * Security-constrained optimisation: branch flows after any of the given
   * branch outages (linearised via BODF) must respect the branch limits.
   * @param {object} [opts]
   * @param {Array} [opts.branch_outages] names of lines or [component, name] pairs
   */
  proto.optimize_security_constrained = async function optimizeSecurityConstrained(opts = {}) {
    const { snapshots = null, branch_outages = null, multi_investment_periods = false, model_kwargs = {}, ...kwargs } = opts;
    const n = this._n;
    const allPassive = n.passive_branches().index;
    let outagesIdx;
    if (branch_outages === null) outagesIdx = allPassive;
    else {
      const vals = (branch_outages instanceof Index ? branch_outages.values : branch_outages).map((b) => (Array.isArray(b) ? b : ["Line", b]));
      outagesIdx = new Index(vals, ["type", "name"]);
    }
    const missing = outagesIdx.values.filter((b) => !allPassive.has(b));
    if (missing.length) {
      throw new Error(`The following passive branches are not in the network: {${missing.map((b) => `('${b[0]}', '${b[1]}')`).join(", ")}}`);
    }
    if (!allPassive.length) return n.optimize({ snapshots, multi_investment_periods, ...model_kwargs, ...kwargs });

    // outages must be active in at least one optimised investment period
    const sns = as_index(n, snapshots, "snapshots");
    const periods = multi_investment_periods ? sns.uniqueLevel(0).values : null;
    const activeNames = new Map();
    for (const [c] of outagesIdx.values) {
      if (activeNames.has(c)) continue;
      const comp = n.c.get(c);
      const a = comp.get_active_assets(periods);
      activeNames.set(c, new Set(comp.static.index.values.filter((_, i) => a.values[i])));
    }
    const inactive = outagesIdx.values.filter(([c, nm]) => !activeNames.get(c).has(nm));
    if (branch_outages !== null && inactive.length) {
      throw new Error(`The following branch outages are not active in any optimized investment period: {${inactive.map((b) => `('${b[0]}', '${b[1]}')`).join(", ")}}`);
    }

    const m = this.create_model({ snapshots, multi_investment_periods, ...model_kwargs });
    const modelSns = m.parameters.snapshots;
    const windows = n._multi_invest ? sns.uniqueLevel(0).values.map((p) => [p, modelSns.filter(modelSns.values.map((t) => t[0] === p))]) : [[null, null]];
    for (const [period, periodSns] of windows) {
      let suffix = "";
      if (period !== null) {
        n.determine_network_topology({ investment_period: period, skip_isolated_buses: true });
        suffix = `-period-${period}`;
      }
      for (const sub of n.c.sub_networks.static.col("obj")) addSecurityConstraints(m, sub, outagesIdx, periodSns, suffix);
    }
    return this.solve_model(kwargs);
  };

  /**
   * Optimise in windows of `horizon` snapshots overlapping by `overlap`,
   * carrying storage levels from one window to the next.
   */
  proto.optimize_with_rolling_horizon = async function optimizeWithRollingHorizon(opts = {}) {
    const { snapshots: snapshotsIn = null, horizon = 100, overlap = 0, ...kwargs } = opts;
    const n = this._n;
    const snapshots = snapshotsIn === null ? n.snapshots : as_index(n, snapshotsIn, "snapshots");
    if (horizon <= overlap) throw new Error("overlap must be smaller than horizon");
    const starts = [];
    for (let s = 0; s < snapshots.length; s += horizon - overlap) starts.push(s);
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = Math.min(snapshots.length, start + horizon);
      const sns = snapshots.slice(start, end);
      logger.info(`Optimizing network for snapshot horizon [${sns.at(0)}:${sns.at(sns.length - 1)}] (${i + 1}/${starts.length}).`);
      if (i) {
        const prev = snapshots.at(start - 1);
        for (const [cName, dynAttr, initAttr] of [
          ["Store", "e", "e_initial"],
          ["StorageUnit", "state_of_charge", "state_of_charge_initial"],
        ]) {
          const c = n.c.get(cName);
          if (c.static.empty) continue;
          const df = c.dynamic[dynAttr];
          const r = df.index.getLoc(prev);
          // positional assignment (`.values`) like PyPSA
          c.static.set(
            initAttr,
            df.columns.map((col) => df.col(col)[r]),
          );
        }
      }
      const [status, condition] = await n.optimize({ snapshots: sns, ...kwargs });
      if (status !== "ok") logger.warning(`Optimization failed with status ${status} and condition ${condition}`);
    }
    return n;
  };

  /**
   * Optimise, then fix the dispatch and run a non-linear power flow.
   * @returns {Promise<object>} status, termination_condition and pf results
   */
  proto.optimize_and_run_non_linear_powerflow = async function optimizeAndRunNonLinearPowerflow(opts = {}) {
    const { snapshots: snapshotsIn = null, skip_pre = false, x_tol = 1e-6, use_seed = false, distribute_slack = false, slack_weights = "p_set", ...kwargs } = opts;
    const n = this._n;
    const snapshots = snapshotsIn ?? n.snapshots;
    const [status, condition] = await n.optimize({ snapshots, ...kwargs });
    if (status !== "ok") {
      logger.warning(`Optimization failed with status ${status} and condition ${condition}`);
      return { status, termination_condition: condition };
    }
    for (const c of [...n.one_port_components, "Process", "Link"]) {
      const comp = n.c.get(c);
      comp.dynamic.p_set = comp.dynamic.p;
    }
    const gens = n.c.generators.static;
    gens.set("control", gens.index.values.map(() => "PV"));
    const subs = n.c.sub_networks.static.col("obj");
    for (const sub of subs) if (sub.slack_generator !== null && sub.slack_generator !== undefined) gens.setAt(sub.slack_generator, "control", "Slack");
    for (const sub of subs) {
      const g = sub.c.get("generators").static.index;
      const other = g.difference(new Index([sub.slack_generator]));
      if (!other.empty) gens.setAt(other.at(0), "control", "PQ");
    }
    logger.info("Running non-linear power flow iteratively...");
    const res = await n.pf({ snapshots, skip_pre, x_tol, use_seed, distribute_slack, slack_weights });
    return { status, termination_condition: condition, ...res };
  };
}

/** Branch outage constraints of a sub-network (`_add_security_constraints`). */
function addSecurityConstraints(m, sub, branchOutages, periodSns, suffix) {
  const branchesI = sub.branches_i();
  const outages = branchesI.intersection(branchOutages);
  if (outages.empty) return;
  sub.calculate_BODF();
  const pos = (b) => branchesI.getLoc(b);
  const unique0 = (idx) => [...new Set(idx.values.map((b) => b[0]))];
  for (const cOutage of unique0(outages)) {
    for (const cAffected of unique0(branchesI)) {
      const outDim = `${cOutage}-outage`;
      const cOutages = outages.values.filter((b) => b[0] === cOutage).map((b) => b[1]);
      const flowVar = m.variables.get(`${cOutage}-s`);
      const affected = branchesI.values.filter((b) => b[0] === cAffected).map((b) => b[1]);
      for (const bound of ["lower", "upper"]) {
        for (const kind of ["fix", "ext"]) {
          const cname = `${cAffected}-${kind}-s-${bound}`;
          const con = m.constraints.get(cname);
          if (!con) continue;
          const ni = con.dims.indexOf("name");
          const si = con.dims.indexOf("snapshot");
          const idx = con.coords[ni].intersection(new Index(affected));
          const snsC = periodSns ?? con.coords[si];
          const name = `${cname}-security-for-${outDim}-in-sub-network-${sub.name}${suffix}`;
          const nc = m.new_constraint(name, ["snapshot", "name", outDim], [snsC, new Index(idx.values, "name"), new Index(cOutages, outDim)]);
          for (let s = 0; s < snsC.length; s++) {
            const sn = snsC.at(s);
            const sc = con.coords[si].getLoc(sn);
            for (const aff of idx) {
              const j = con.coords[ni].getLoc(aff);
              const k = con.flat(...(si === 0 ? [sc, j] : [j, sc]));
              const [vs, cs] = con.rawTerms(k);
              for (const o of cOutages) {
                const bodf = sub.BODF[pos([cAffected, aff])][pos([cOutage, o])];
                nc.push([...vs, flowVar.get(sn, o)], [...cs, bodf], con.sign[k], con.rhs[k]);
              }
            }
          }
          m.add_constraint(nc);
        }
      }
    }
  }
}
