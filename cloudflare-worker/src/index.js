const DEFAULT_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const DIMENSION_MIN = 256;
const DIMENSION_MAX = 1920;
const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(env.API_TOKEN && token === env.API_TOKEN);
}

function integer(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < DIMENSION_MIN || parsed > DIMENSION_MAX) {
    throw new Error(`${name} must be an integer from ${DIMENSION_MIN} to ${DIMENSION_MAX}`);
  }
  return parsed;
}

export function validateInput(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  if (prompt.length > 10000) throw new Error("prompt must not exceed 10000 characters");
  const input = {
    prompt,
    width: integer(body.width, 1024, "width"),
    height: integer(body.height, 768, "height")
  };
  if (body.guidance !== undefined) {
    const guidance = Number(body.guidance);
    if (!Number.isFinite(guidance) || guidance < 0 || guidance > 100) throw new Error("guidance must be from 0 to 100");
    input.guidance = guidance;
  }
  if (body.seed !== undefined) {
    const seed = Number(body.seed);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
    input.seed = seed;
  }
  if (body.input_image_0 !== undefined) {
    const image = body.input_image_0;
    if (!(image instanceof Blob) || !image.type.startsWith("image/")) {
      throw new Error("input_image_0 must be an image file");
    }
    if (!image.size || image.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error("input_image_0 must be from 1 byte to 5 MB");
    }
    input.input_image_0 = image;
  }
  return input;
}

function toMultipart(input) {
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) {
    if (value instanceof Blob) form.append(key, value, "reference-image");
    else form.append(key, String(value));
  }
  const serialized = new Response(form);
  return { body: serialized.body, contentType: serialized.headers.get("content-type") };
}

export function imageContentType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, model: env.MODEL || DEFAULT_MODEL });
    }
    if (url.pathname !== "/generate" || request.method !== "POST") return json({ error: "Not found" }, 404);
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);

    let input;
    try {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.startsWith("multipart/form-data")) {
        const form = await request.formData();
        input = validateInput(Object.fromEntries(form.entries()));
      } else {
        input = validateInput(await request.json());
      }
    } catch (error) {
      return json({ error: error.message || "Invalid JSON body" }, 400);
    }

    try {
      const result = await env.AI.run(env.MODEL || DEFAULT_MODEL, { multipart: toMultipart(input) });
      const image = result?.image;
      if (typeof image !== "string" || !image) throw new Error("Workers AI returned no image");
      const bytes = Uint8Array.from(atob(image), character => character.charCodeAt(0));
      const contentType = imageContentType(bytes);
      if (contentType === "application/octet-stream") throw new Error("Workers AI returned an unknown image format");
      return new Response(bytes, {
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          "x-image-model": env.MODEL || DEFAULT_MODEL
        }
      });
    } catch (error) {
      return json({ error: "Image generation failed", detail: error.message }, 502);
    }
  }
};
