import test from "node:test";
import assert from "node:assert/strict";

await import("./chatgpt-image-detector.js");
const { generatedImageCandidate, generatedImages } = globalThis.ChatGPTImageDetector;

function fakeImage(overrides = {}) {
  return {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=file_image&ts=1&sig=old",
    src: "",
    alt: "Generated image: test",
    complete: true,
    naturalWidth: 1536,
    naturalHeight: 1024,
    getClientRects: () => [{}],
    closest: selector => selector.includes("imagegen-image") ? {} : null,
    ...overrides
  };
}

test("detects generated images in the new imagegen DOM without an assistant ancestor", () => {
  const result = generatedImageCandidate(fakeImage());
  assert.equal(result.key, "/backend-api/estuary/content?id=file_image");
  assert.equal(result.width, 1536);
});

test("uses a stable identity when the signed URL changes", () => {
  const first = generatedImageCandidate(fakeImage());
  const second = generatedImageCandidate(fakeImage({
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=file_image&ts=2&sig=new"
  }));
  assert.equal(first.key, second.key);
  assert.notEqual(first.url, second.url);
});

test("rejects hidden, incomplete, small, and unrelated images", () => {
  assert.equal(generatedImageCandidate(fakeImage({ complete: false })), null);
  assert.equal(generatedImageCandidate(fakeImage({ naturalWidth: 64 })), null);
  assert.equal(generatedImageCandidate(fakeImage({ getClientRects: () => [] })), null);
  assert.equal(generatedImageCandidate(fakeImage({ currentSrc: "https://example.com/photo.png" })), null);
});

test("deduplicates layered copies of the same generated image", () => {
  const small = fakeImage({ naturalWidth: 1024, naturalHeight: 768 });
  const large = fakeImage();
  const documentRoot = { querySelectorAll: () => [small, large] };
  const results = generatedImages(documentRoot);
  assert.equal(results.length, 1);
  assert.equal(results[0].width, 1536);
});
