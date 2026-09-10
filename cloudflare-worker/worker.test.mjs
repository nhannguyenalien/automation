import test from "node:test";
import assert from "node:assert/strict";
import worker, { imageContentType, validateInput } from "./src/index.js";

test("validates and normalizes generation input", () => {
  assert.deepEqual(validateInput({ prompt: "  hello  ", width: 1024, height: 768, seed: 12 }), {
    prompt: "hello", width: 1024, height: 768, seed: 12
  });
  assert.throws(() => validateInput({ prompt: "x", width: 100 }), /width/);
  assert.throws(() => validateInput({}), /prompt/);
});

test("requires bearer auth", async () => {
  const response = await worker.fetch(new Request("https://worker.test/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" })
  }), { API_TOKEN: "secret" });
  assert.equal(response.status, 401);
});

test("returns decoded image bytes", async () => {
  const response = await worker.fetch(new Request("https://worker.test/generate", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello" })
  }), { API_TOKEN: "secret", AI: { run: async () => ({ image: btoa("\u00ff\u00d8\u00ffPNG") }) } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal((await response.arrayBuffer()).byteLength, 6);
});

test("detects common image formats", () => {
  assert.equal(imageContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), "image/png");
  assert.equal(imageContentType(Uint8Array.from([0xff, 0xd8, 0xff])), "image/jpeg");
});
