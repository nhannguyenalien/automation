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

test("accepts one reference image", () => {
  const image = new Blob([Uint8Array.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  assert.equal(validateInput({ prompt: "edit it", input_image_0: image }).input_image_0, image);
  assert.throws(() => validateInput({ prompt: "edit it", input_image_0: "not-an-image" }), /image file/);
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

test("forwards multipart reference image to Workers AI", async () => {
  let received;
  const form = new FormData();
  form.append("prompt", "turn it into a watercolor");
  form.append("width", "512");
  form.append("height", "512");
  form.append("input_image_0", new Blob([Uint8Array.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "input.jpg");
  const response = await worker.fetch(new Request("https://worker.test/generate", {
    method: "POST", headers: { authorization: "Bearer secret" }, body: form
  }), {
    API_TOKEN: "secret",
    AI: { run: async (_model, options) => {
      const forwarded = await new Response(options.multipart.body, { headers: { "content-type": options.multipart.contentType } }).formData();
      received = forwarded.get("input_image_0");
      return { image: btoa("\u00ff\u00d8\u00ffPNG") };
    } }
  });
  assert.equal(response.status, 200);
  assert.equal(received.type, "image/jpeg");
  assert.equal(received.size, 3);
});

test("detects common image formats", () => {
  assert.equal(imageContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), "image/png");
  assert.equal(imageContentType(Uint8Array.from([0xff, 0xd8, 0xff])), "image/jpeg");
});
