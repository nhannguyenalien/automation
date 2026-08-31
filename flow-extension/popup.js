const ids = ["apiUrl", "apiKey", "workerId", "enabled"];
const fields = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const status = document.getElementById("status");

chrome.storage.local.get(ids, values => {
  fields.apiUrl.value = values.apiUrl || "http://127.0.0.1:8787";
  fields.apiKey.value = values.apiKey || "";
  fields.workerId.value = values.workerId || `chrome-${crypto.randomUUID().slice(0, 8)}`;
  fields.enabled.checked = Boolean(values.enabled);
});

document.getElementById("save").addEventListener("click", async () => {
  const values = { apiUrl: fields.apiUrl.value.trim().replace(/\/$/, ""), apiKey: fields.apiKey.value, workerId: fields.workerId.value.trim(), enabled: fields.enabled.checked, lastError: "", blockedLanes: {} };
  await chrome.storage.local.set(values);
  chrome.runtime.sendMessage({ type: "POLL_NOW" });
  status.textContent = "Đã lưu. Worker đang kiểm tra queue.";
});
