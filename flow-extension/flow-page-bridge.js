// Runs in Flow's MAIN world so it can read blob: URLs created by the app.
// Only the media bytes cross into the isolated extension content script.
window.addEventListener("message", async event => {
  if (event.source !== window || event.data?.type !== "FLOW_READ_MEDIA_BLOB") return;
  const { id, url } = event.data;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    window.postMessage({
      type: "FLOW_MEDIA_BLOB_RESULT",
      id,
      ok: true,
      contentType: response.headers.get("content-type") || "video/mp4",
      buffer
    }, "*", [buffer]);
  } catch (error) {
    window.postMessage({
      type: "FLOW_MEDIA_BLOB_RESULT",
      id,
      ok: false,
      error: error?.message || String(error)
    }, "*");
  }
});
