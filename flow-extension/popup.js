import { flowProjectRoot } from "./flow-url.js";

const ids = ["apiUrl", "apiKey", "workerId", "flowProjectUrl", "enabled"];
const fields = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const status = document.getElementById("status");
const capabilityFields = [...document.querySelectorAll("[data-capability]")];
document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

chrome.storage.local.get([...ids, "capabilities"], values => {
  fields.apiUrl.value = values.apiUrl || "http://127.0.0.1:8787";
  fields.apiKey.value = values.apiKey || "";
  fields.workerId.value = values.workerId || `chrome-${crypto.randomUUID().slice(0, 8)}`;
  fields.flowProjectUrl.value = values.flowProjectUrl || values.flowResolvedProjectUrl || "";
  fields.enabled.checked = Boolean(values.enabled);
  const enabledCapabilities = Array.isArray(values.capabilities)
    ? values.capabilities
    : capabilityFields.map(field => field.dataset.capability);
  for (const field of capabilityFields) field.checked = enabledCapabilities.includes(field.dataset.capability);
});

function projectRoot(url) {
  return flowProjectRoot(url);
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
  const capabilities = capabilityFields.filter(field => field.checked).map(field => field.dataset.capability);
  const values = { apiUrl: fields.apiUrl.value.trim().replace(/\/$/, ""), apiKey: fields.apiKey.value, workerId: fields.workerId.value.trim(), flowProjectUrl, enabled: fields.enabled.checked, capabilities, lastError: "", blockedLanes: {} };
  await chrome.storage.local.set(values);
  chrome.runtime.sendMessage({ type: "POLL_NOW" });
  status.textContent = "Đã lưu. Worker đang kiểm tra queue.";
});

document.getElementById("update").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  status.textContent = "Đang yêu cầu Windows tải bản mới từ GitHub…";
  try {
    const response = await fetch("http://127.0.0.1:8765/update", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (result.version === chrome.runtime.getManifest().version) {
      status.textContent = `Đã là bản mới nhất v${result.version}.`;
      return;
    }
    status.textContent = `Đã tải v${result.version}. Extension đang khởi động lại…`;
    setTimeout(() => chrome.runtime.reload(), 700);
  } catch (error) {
    status.textContent = `Không gọi được updater Windows: ${error.message}\nHãy chạy lại vm-setup\\install-updater.ps1 bằng PowerShell Administrator.`;
  } finally {
    button.disabled = false;
  }
});
