import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_LANE_RETRY_MAX_MS,
  canRetryLane,
  createLaneBlock
} from "./lane-recovery.js";

test("legacy permanent blocks resume after upgrading", () => {
  assert.equal(canRetryLane({ at: "2026-09-01T00:00:00.000Z", error: "timeout" }), true);
});

test("lane remains blocked until retryAt", () => {
  const block = createLaneBlock(null, "timeout", 1_000_000);
  assert.equal(canRetryLane(block, 1_029_999), false);
  assert.equal(canRetryLane(block, 1_030_000), true);
});

test("repeated failures back off and cap at five minutes", () => {
  let block;
  const delays = [];
  for (let failure = 0; failure < 8; failure += 1) {
    block = createLaneBlock(block, "timeout", 1_000_000);
    delays.push(Date.parse(block.retryAt) - 1_000_000);
  }
  assert.deepEqual(delays.slice(0, 5), [30_000, 60_000, 120_000, 240_000, IMAGE_LANE_RETRY_MAX_MS]);
  assert.equal(delays.at(-1), IMAGE_LANE_RETRY_MAX_MS);
});
