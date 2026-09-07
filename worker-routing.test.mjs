import test from "node:test";
import assert from "node:assert/strict";
import { applyChatProviderFallback, normalizeCapabilities, taskCapability, workerCanRun, workerRetryReady } from "./worker-routing.mjs";

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

test("failed ChatGPT chat falls back once to Gemini and gets another attempt", () => {
  const job = {
    type: "chat", provider: "chatgpt", model: "default", chatUrl: "https://chatgpt.com/",
    status: "running", attempts: [1], failoverMaxAttempts: {},
    workerRetryAfter: { 0: { "pc-1-chat": 999999 } }, logs: []
  };

  assert.equal(applyChatProviderFallback(job, 0, "ChatGPT input missing"), true);
  assert.equal(job.provider, "gemini");
  assert.equal(job.model, "3.5-flash-lite");
  assert.equal(job.chatUrl, "https://gemini.google.com/app");
  assert.equal(job.status, "queued");
  assert.equal(job.failoverMaxAttempts[0], 2);
  assert.equal(job.workerRetryAfter[0], undefined);
  assert.equal(workerCanRun(job, ["chat:gemini:3.5-flash-lite"]), true);
  assert.equal(applyChatProviderFallback(job, 0, "second failure"), false);
});

test("provider fallback does not affect Gemini or non-chat jobs", () => {
  assert.equal(applyChatProviderFallback({ type: "chat", provider: "gemini" }, 0, "error"), false);
  assert.equal(applyChatProviderFallback({ type: "image", provider: "chatgpt" }, 0, "error"), false);
});
