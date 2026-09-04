(function installChatGPTImageDetector(root) {
  const GENERATED_ALT = /(?:generated image|image generated|ảnh (?:đã )?tạo)/i;
  const MIN_IMAGE_EDGE = 256;

  function imageUrl(image) {
    return String(image?.currentSrc || image?.src || "").trim();
  }

  function parsedGeneratedUrl(value) {
    try {
      const url = new URL(value, "https://chatgpt.com/");
      if (url.hostname !== "chatgpt.com") return null;
      if (url.pathname === "/backend-api/estuary/content") return url;
      if (/^\/backend-api\/(?:files|generated-image)\//.test(url.pathname)) return url;
      return null;
    } catch {
      return null;
    }
  }

  function hasGeneratedContext(image) {
    if (GENERATED_ALT.test(String(image?.alt || ""))) return true;
    if (image?.closest?.('[class*="imagegen-image"]')) return true;
    return Boolean(image?.closest?.('[data-message-author-role="assistant"]'));
  }

  function generatedImageCandidate(image) {
    const url = parsedGeneratedUrl(imageUrl(image));
    if (!url || !image?.complete) return null;
    const width = Number(image.naturalWidth || 0);
    const height = Number(image.naturalHeight || 0);
    if (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE) return null;
    if (image.getClientRects && image.getClientRects().length === 0) return null;
    if (!hasGeneratedContext(image)) return null;
    const fileId = url.searchParams.get("id");
    const key = fileId ? `${url.pathname}?id=${fileId}` : url.pathname;
    return { key, url: url.href, width, height };
  }

  function generatedImages(documentRoot) {
    const images = [...documentRoot.querySelectorAll("main img, [data-message-author-role=\"assistant\"] img")];
    const unique = new Map();
    for (const image of images) {
      const candidate = generatedImageCandidate(image);
      if (!candidate) continue;
      const previous = unique.get(candidate.key);
      if (!previous || candidate.width * candidate.height > previous.width * previous.height) {
        unique.set(candidate.key, candidate);
      }
    }
    return [...unique.values()];
  }

  root.ChatGPTImageDetector = { generatedImageCandidate, generatedImages };
})(globalThis);
