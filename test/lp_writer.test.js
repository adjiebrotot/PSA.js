// SPDX-License-Identifier: MIT
/** LP writer internals that only show on large models. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lpRowOrder } from "../src/optimization/linopy.js";

test("LP rows follow linopy's iterate_slices for blocks above slice_size", () => {
  // [shape, _term size, slice_size, order of linopy.common.iterate_slices]
  const cases = [
    [[2, 5], 3, 10, [0, 1, 5, 6, 2, 3, 7, 8, 4, 9]],
    [[7, 3], 1, 5, null],
    [[4, 4], 2, 7, null],
    [[3], 1, 2, null],
    [[2, 3, 4], 1, 5, [0, 4, 8, 12, 16, 20, 1, 5, 9, 13, 17, 21, 2, 6, 10, 14, 18, 22, 3, 7, 11, 15, 19, 23]],
    [[5, 2], 4, 100, null],
  ];
  for (const [shape, nterm, sliceSize, expected] of cases) {
    const order = lpRowOrder(shape, nterm, sliceSize);
    const cOrder = Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_, k) => k);
    assert.deepEqual(order === null ? cOrder : Array.from(order), expected ?? cOrder, JSON.stringify([shape, nterm, sliceSize]));
  }
  // linopy's default slice size: 2,000,000 elements incl. the term dimension
  assert.equal(lpRowOrder([24, 2044], 40), null);
  assert.deepEqual(Array.from(lpRowOrder([24, 2044], 66).slice(1020, 1024)), [1020, 1021, 2044, 2045]);
});
