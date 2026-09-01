const ids = ["apiUrl", "apiKey", "workerId", "flowProjectUrl", "enabled"];
const fields = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const status = document.getElementById("status");

chrome.storage.local.get(ids, values => {
  fields.apiUrl.value = values.apiUrl || "http://127.0.0.1:8787";
  fields.apiKey.value = values.apiKey || "";
  fields.workerId.value = values.workerId || `chrome-${crypto.randomUUID().slice(0, 8)}`;
  fields.flowProjectUrl.value = values.flowProjectUrl || values.flowResolvedProjectUrl || "";
  fields.enabled.checked = Boolean(values.enabled);
});

function projectRoot(url) {
  try {
    const current = new URL(url);
    const rootPath = current.pathname.match(/^(.*\/tools\/flow\/project\/[^/]+)/)?.[1];
    return rootPath ? `${current.origin}${rootPath}` : "";
  } catch {
    return "";
  }
}

document.getElementById("useCurrentProject").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = projectRoot(tab?.url);
  if (!url) {
    status.textContent = "Tab hiện tại không phải một project Google Flow.";
    return;
  }
  fields.flowProjectUrl.value = url;
  await chrome.storage.local.set({ flowProjectUrl: url, flowResolvedProjectUrl: url });
  status.textContent = `Đã ghim project: ${url}`;
});

document.getElementById("save").addEventListener("click", async () => {
  const flowProjectUrl = projectRoot(fields.flowProjectUrl.value.trim());
  if (fields.flowProjectUrl.value.trim() && !flowProjectUrl) {
    status.textContent = "Flow project URL không hợp lệ.";
    return;
  }
  const values = { apiUrl: fields.apiUrl.value.trim().replace(/\/$/, ""), apiKey: fields.apiKey.value, workerId: fields.workerId.value.trim(), flowProjectUrl, enabled: fields.enabled.checked, lastError: "", blockedLanes: {} };
  await chrome.storage.local.set(values);
  chrome.runtime.sendMessage({ type: "POLL_NOW" });
  status.textContent = "Đã lưu. Worker đang kiểm tra queue.";
});
