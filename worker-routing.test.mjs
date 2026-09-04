import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCapabilities, taskCapability, workerCanRun, workerRetryReady } from "./worker-routing.mjs";

test("matches task by type, provider and model", () => {
  const job = { type: "chat", provider: "gemini", model: "3.1-pro" };
  assert.equal(taskCapability(job), "chat:gemini:3.1-pro");
  assert.equal(workerCanRun(job, ["chat:gemini:3.1-pro"]), true);
  assert.equal(workerCanRun(job, ["chat:gemini:3.5-flash-lite"]), false);
});

test("legacy workers without capabilities remain compatible", () => {
  assert.equal(workerCanRun({ type: "video", model: "veo-3.1-lite" }, undefined), true);
});

test("normalization drops unknown capabilities", () => {
  assert.deepEqual(normalizeCapabilities(["CHAT:GEMINI:3.1-PRO", "unknown"]), ["chat:gemini:3.1-pro"]);
});

test("failed worker waits for its retry cooldown while another worker can claim", () => {
  const job = { workerRetryAfter: { 0: { "pc-1-chat": 2000 } } };
  assert.equal(workerRetryReady(job, 0, "pc-1-chat", 1000), false);
  assert.equal(workerRetryReady(job, 0, "pc-2-chat", 1000), true);
  assert.equal(workerRetryReady(job, 0, "pc-1-chat", 2000), true);
});
