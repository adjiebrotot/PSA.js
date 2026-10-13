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
  cluster_by_busmap(busmap, opts = {}) {
    return this.spatial.cluster_by_busmap(busmap, opts);
  }

  get_clustering_from_busmap(busmap, opts = {}) {
    return this.spatial.get_clustering_from_busmap(busmap, opts);
  }

  busmap_by_kmeans(bus_weightings, n_clusters, opts = {}) {
    return this.spatial.busmap_by_kmeans(bus_weightings, n_clusters, opts);
  }

  cluster_spatially_by_kmeans(bus_weightings, n_clusters, opts = {}) {
    return this.spatial.cluster_by_kmeans(bus_weightings, n_clusters, opts);
  }
}

Network._accessorInitialisers.push((n) => {
  Object.defineProperty(n, "cluster", { value: new ClusteringAccessor(n), writable: true, configurable: true, enumerable: false });
});

export * from "./spatial.js";
export * from "./temporal.js";
