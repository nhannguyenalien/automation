import test from "node:test";
import assert from "node:assert/strict";
import { flowProjectRoot, isSameFlowProject, parseFlowUrl } from "./flow-url.js";

const legacy = "https://labs.google/fx/vi/tools/flow/project/15cb0eb9-f2de-45cb-a136-90112c7312f7";
const current = "https://flow.google.com/project/15cb0eb9-f2de-45cb-a136-90112c7312f7";

test("treats legacy and current Flow URLs as the same project", () => {
  assert.equal(isSameFlowProject(legacy, current), true);
  assert.equal(isSameFlowProject(`${legacy}/scene/abc`, `${current}/scene/xyz`), true);
});

test("extracts project and scene IDs from both Flow URL formats", () => {
  assert.deepEqual(parseFlowUrl(`${current}/scene/scene-1`)?.projectId, "15cb0eb9-f2de-45cb-a136-90112c7312f7");
  assert.equal(parseFlowUrl(`${legacy}/scene/scene-1`)?.sceneId, "scene-1");
});

test("returns a project root in the input URL format", () => {
  assert.equal(flowProjectRoot(`${current}/scene/scene-1`), current);
  assert.equal(flowProjectRoot(`${legacy}/scene/scene-1`), legacy);
});

test("rejects lookalike and unrelated URLs", () => {
  assert.equal(parseFlowUrl("https://flow.google.com.evil.example/project/id"), null);
  assert.equal(parseFlowUrl("https://flow.google.com/"), null);
  assert.equal(isSameFlowProject(current, "https://example.com/project/15cb0eb9-f2de-45cb-a136-90112c7312f7"), false);
});
