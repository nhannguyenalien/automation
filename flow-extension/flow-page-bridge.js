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

// Flow opens uploads through an input.click()/showPicker() call. Intercept the
// next picker in the page's MAIN world and provide the File directly, avoiding
// macOS's native chooser (which an extension cannot reliably control).
let pendingFlowUpload = null;

function flowFileInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  return inputs.find(input => (input.accept || "").trim() === "image/*") ||
    inputs.find(input => !input.accept || /image|png|jpe?g|webp/i.test(input.accept)) ||
    inputs[0] || null;
}

function completeFlowUpload(input) {
  const pending = pendingFlowUpload;
  if (!pending || !(input instanceof HTMLInputElement) || input.type !== "file") return false;
  pendingFlowUpload = null;
  try {
    const transfer = new DataTransfer();
    transfer.items.add(pending.file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    window.postMessage({ type: "FLOW_UPLOAD_FILE_RESULT", id: pending.id, ok: true }, "*");
  } catch (error) {
    window.postMessage({
      type: "FLOW_UPLOAD_FILE_RESULT",
      id: pending.id,
      ok: false,
      error: error?.message || String(error)
    }, "*");
  }
  return true;
}

const nativeInputClick = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function (...args) {
  if (completeFlowUpload(this)) return;
  return nativeInputClick.apply(this, args);
};

if (HTMLInputElement.prototype.showPicker) {
  const nativeShowPicker = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function (...args) {
    if (completeFlowUpload(this)) return;
    return nativeShowPicker.apply(this, args);
  };
}

document.addEventListener("click", event => {
  const input = event.target instanceof Element ? event.target.closest('input[type="file"]') : null;
  if (!pendingFlowUpload) return;
  const target = event.target instanceof Element ? event.target : null;
  const label = target?.closest("label");
  // A label can activate its associated file input without calling the
  // JavaScript click() override. Handle that native path explicitly, but do
  // not guess an input from the Upload menu button: Flow keeps stale hidden
  // file inputs mounted and the first one may belong to a previous dialog.
  const selectedInput = input || (label?.control instanceof HTMLInputElement && label.control.type === "file"
    ? label.control
    : null);
  if (!selectedInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  completeFlowUpload(selectedInput);
}, true);

window.addEventListener("message", async event => {
  if (event.source !== window || event.data?.type !== "FLOW_ARM_FILE_UPLOAD") return;
  const { id, dataUrl, filename } = event.data;
  try {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    pendingFlowUpload = {
      id,
      file: new File([blob], filename, { type: blob.type || "image/jpeg", lastModified: Date.now() })
    };
    // Signal the isolated script to click Flow's Upload action only after the
    // bytes are ready. Do not populate an already-mounted input here: Flow
    // retains stale picker inputs, and changing one before opening the picker
    // is silently ignored by its current React handler.
    window.postMessage({ type: "FLOW_UPLOAD_FILE_ARMED", id, ok: true }, "*");
  } catch (error) {
    window.postMessage({
      type: "FLOW_UPLOAD_FILE_ARMED",
      id,
      ok: false,
      error: error?.message || String(error)
    }, "*");
  }
});
