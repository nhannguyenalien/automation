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
  status.textContent = "Đang kiểm tra bản mới trên backend image-ai…";
  try {
    const apiUrl = fields.apiUrl.value.trim().replace(/\/$/, "");
    if (!apiUrl) throw new Error("Chưa cấu hình API URL");
    const latestResponse = await fetch(`${apiUrl}/extension/latest`, {
      headers: fields.apiKey.value ? { authorization: `Bearer ${fields.apiKey.value}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    const latest = await latestResponse.json();
    if (!latestResponse.ok || !latest.version) {
      throw new Error(latest.error || `Backend HTTP ${latestResponse.status}`);
    }
    if (latest.version === chrome.runtime.getManifest().version) {
      status.textContent = `Đã là bản mới nhất v${latest.version}.`;
      return;
    }
    status.textContent = `Backend có v${latest.version}. Đang cài đặt trên máy…`;
    const response = await fetch("http://127.0.0.1:8765/update", {
      method: "POST",
      signal: AbortSignal.timeout(120000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    status.textContent = `Đã tải v${result.version}. Extension đang khởi động lại…`;
    setTimeout(() => chrome.runtime.reload(), 700);
  } catch (error) {
    const platform = (await chrome.runtime.getPlatformInfo()).os;
    const setup = platform === "mac"
      ? "Hãy chạy lại mac-setup/install-updater.sh trong Terminal."
      : "Hãy chạy lại vm-setup\\install-updater.ps1 bằng PowerShell Administrator.";
    status.textContent = `Cập nhật thất bại: ${error.message}\n${setup}`;
  } finally {
    button.disabled = false;
  }
});
