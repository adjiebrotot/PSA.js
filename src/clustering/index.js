// SPDX-License-Identifier: MIT
/** Clustering accessor `n.cluster` with `spatial` and `temporal` sub-accessors. */

import { Network } from "../network/network.js";
import { SpatialClusteringAccessor } from "./spatial.js";
import { TemporalClusteringAccessor } from "./temporal.js";

export class ClusteringAccessor {
  constructor(n) {
    this._n = n;
    this.spatial = new SpatialClusteringAccessor(n);
    this.temporal = new TemporalClusteringAccessor(n);
  }

  // deprecated aliases kept for compatibility with PyPSA < 1.1 style calls
  /** Deprecated alias of `n.cluster.spatial.cluster_by_busmap`. */
  cluster_by_busmap(busmap, opts = {}) {
    return this.spatial.cluster_by_busmap(busmap, opts);
  }

  /** Deprecated alias of `n.cluster.spatial.get_clustering_from_busmap`. */
  get_clustering_from_busmap(busmap, opts = {}) {
    return this.spatial.get_clustering_from_busmap(busmap, opts);
  }

  /** Deprecated alias of `n.cluster.spatial.busmap_by_kmeans`. */
  busmap_by_kmeans(bus_weightings, n_clusters, opts = {}) {
    return this.spatial.busmap_by_kmeans(bus_weightings, n_clusters, opts);
  }

  /** Deprecated alias of `n.cluster.spatial.cluster_by_kmeans`. */
  cluster_spatially_by_kmeans(bus_weightings, n_clusters, opts = {}) {
    return this.spatial.cluster_by_kmeans(bus_weightings, n_clusters, opts);
  }

  /** Deprecated alias of `n.cluster.spatial.busmap_by_hac`. */
  busmap_by_hac(n_clusters, opts = {}) {
    return this.spatial.busmap_by_hac(n_clusters, opts);
  }

  /** Deprecated alias of `n.cluster.spatial.cluster_by_hac`. */
  cluster_spatially_by_hac(n_clusters, opts = {}) {
    return this.spatial.cluster_by_hac(n_clusters, opts);
  }

  /** Deprecated alias of `n.cluster.spatial.busmap_by_greedy_modularity`. */
  busmap_by_greedy_modularity(n_clusters, buses_i = null) {
    return this.spatial.busmap_by_greedy_modularity(n_clusters, buses_i);
  }

  /** Deprecated alias of `n.cluster.spatial.cluster_by_greedy_modularity`. */
  cluster_spatially_by_greedy_modularity(n_clusters, buses_i = null, opts = {}) {
    return this.spatial.cluster_by_greedy_modularity(n_clusters, buses_i, opts);
  }
}

Network._accessorInitialisers.push((n) => {
  Object.defineProperty(n, "cluster", { value: new ClusteringAccessor(n), writable: true, configurable: true, enumerable: false });
});

export * from "./spatial.js";
export * from "./temporal.js";
