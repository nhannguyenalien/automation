import { runtimeDefaults } from "./runtime-config.js";
import { canRetryLane, createLaneBlock } from "./lane-recovery.js";

const defaults = {
  apiUrl: runtimeDefaults.apiUrl || "http://127.0.0.1:8787",
  apiKey: runtimeDefaults.apiKey || "",
  workerId: runtimeDefaults.workerId || `chrome-${crypto.randomUUID().slice(0, 8)}`,
  enabled: runtimeDefaults.enabled ?? false
};
const busyLanes = { chat: false, image: false, video: false };
let flowTabLock = Promise.resolve();

function isSystemicWorkerError(lane, message) {
  if (lane !== "image") return false;
  return /(?:ảnh viewer khớp (?:thẻ kết quả|ứng viên)|thẻ (?:kết quả mới đã biến mất|ảnh ứng viên)|thư viện ảnh Flow chưa ổn định|không tìm thấy.*(?:nút cấu hình|trình tạo|ô prompt Flow|ảnh kết quả mới))/i.test(String(message || ""));
}

async function config() {
  const saved = await chrome.storage.local.get(Object.keys(defaults));
  const merged = runtimeDefaults.force ? { ...saved, ...defaults } : { ...defaults, ...saved };
  const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => saved[key] === undefined));
  const updates = runtimeDefaults.force ? defaults : missing;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  return merged;
}

async function api(path, body) {
  const cfg = await config();
  const response = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `API HTTP ${response.status}`);
  return json;
}

async function uploadOutput(path, data, contentType) {
  const cfg = await config();
  const response = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": contentType, authorization: `Bearer ${cfg.apiKey}` },
    body: data
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `API HTTP ${response.status}`);
  return json;
}

async function referenceDataUrl(url) {
  const cfg = await config();
  const apiOrigin = new URL(cfg.apiUrl).origin;
  const target = new URL(url);
  const headers = target.origin === apiOrigin ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const response = await fetch(target, { headers });
  if (!response.ok) throw new Error(`Không tải được ảnh tham chiếu: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("referenceImageUrl không trả về file ảnh");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function flowTab(projectUrl, type) {
  const { flowProjectUrl = "" } = await chrome.storage.local.get("flowProjectUrl");
  // A project URL attached to the API job is authoritative. The value pinned
  // in the popup is only a fallback for older callers which omit projectUrl.
  const requested = new URL(projectUrl || flowProjectUrl);
  if (!requested.pathname.includes("/tools/flow/project/")) {
    throw new Error(`projectUrl phải là URL project Flow, hiện nhận được: ${projectUrl || flowProjectUrl}`);
  }
  const requestedPath = requested.origin + requested.pathname;
  let targetPath = requestedPath;
  const projectPath = requested.pathname.match(/^(.*\/tools\/flow\/project\/[^/]+)/)?.[1];
  const ownKey = type === "video" ? "flowVideoTabId" : "flowImageTabId";
  const otherKey = type === "video" ? "flowImageTabId" : "flowVideoTabId";
  const projectRoot = candidate => {
    try {
      const current = new URL(candidate?.url || candidate);
      const rootPath = current.pathname.match(/^(.*\/tools\/flow\/project\/[^/]+)/)?.[1];
      return rootPath ? `${current.origin}${rootPath}` : null;
    } catch {
      return null;
    }
  };
  const effectiveProjectUrl = requested.href;
  const createDedicatedTab = async (url = effectiveProjectUrl) => {
    const created = await chrome.tabs.create({ url, active: true });
    await chrome.storage.local.set({ [ownKey]: created.id });
    return created;
  };

  // Image and video must never share one Flow tab. Serialise tab assignment
  // because the image/video lanes can both start immediately after reload.
  const previousLock = flowTabLock;
  let releaseLock;
  flowTabLock = new Promise(resolve => { releaseLock = resolve; });
  await previousLock;
  let tab;
  try {
    const saved = await chrome.storage.local.get([ownKey, otherKey]);
    const isRequestedProject = candidate => projectRoot(candidate) === `${requested.origin}${projectPath}`;
    const savedTab = saved[ownKey]
      ? await chrome.tabs.get(saved[ownKey]).catch(() => null)
      : null;
    const tabs = await chrome.tabs.query({ url: "https://labs.google/fx/*" });
    const availableProjectTabs = tabs.filter(candidate =>
      candidate.id !== saved[otherKey] && projectRoot(candidate)
    );
    const reusableProjectTab = availableProjectTabs.find(isRequestedProject);

    if (isRequestedProject(savedTab)) {
      // A completed inspection leaves the SPA at /edit/<asset>. Always return
      // the lane's one dedicated tab to the gallery before starting a job.
      tab = await chrome.tabs.update(savedTab.id, { url: effectiveProjectUrl, active: true }).catch(() => null);
    } else if (reusableProjectTab) {
      tab = await chrome.tabs.update(reusableProjectTab.id, { url: effectiveProjectUrl, active: true }).catch(() => null);
      if (tab) {
        await chrome.storage.local.set({ [ownKey]: tab.id, flowResolvedProjectUrl: requestedPath });
      }
    }
    if (!tab) {
      const projectUnused = tabs.find(candidate => isRequestedProject(candidate) && candidate.id !== saved[otherKey]);
      if (projectUnused) {
        tab = await chrome.tabs.update(projectUnused.id, { url: effectiveProjectUrl, active: true }).catch(() => null);
      }
      if (!tab) {
        // Do not navigate a tab assigned to the other media type. A dedicated
        // second project tab preserves each sidebar section between jobs.
        tab = await createDedicatedTab();
      } else {
        await chrome.storage.local.set({ [ownKey]: tab.id });
      }
    }
  } finally {
    releaseLock();
  }

  const started = Date.now();
  let recoveryAttempts = 0;
  while (Date.now() - started < 90000) {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) {
      if (recoveryAttempts >= 2) {
        throw new Error(`Tab Flow ${type} liên tục bị đóng khi đang mở project`);
      }
      recoveryAttempts += 1;
      tab = await createDedicatedTab();
      continue;
    }
    const currentLocation = current.url ? new URL(current.url) : null;
    const isRequestedPage = currentLocation &&
      currentLocation.origin + currentLocation.pathname === targetPath;
    if (isRequestedPage && current.status === "complete") return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  throw new Error(`Flow không vào được project sau 90 giây; URL hiện tại: ${current?.url || "không xác định"}`);
}

async function geminiTab(chatUrl, newConversation) {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  const targetUrl = newConversation ? "https://gemini.google.com/app" : (chatUrl || "https://gemini.google.com/app");
  const target = new URL(targetUrl);
  const targetPath = target.origin + target.pathname.replace(/\/$/, "");
  const exactTab = tabs.find(item => {
    if (!item.url) return false;
    const current = new URL(item.url);
    return current.origin + current.pathname.replace(/\/$/, "") === targetPath;
  });
  const reusableTab = exactTab || tabs.find(item => item.active) || tabs[0];
  let opened;
  if (exactTab) {
    // Updating a tab with its current URL still triggers a full navigation.
    // Keep the loaded composer intact across retries and queued chat jobs.
    opened = await chrome.tabs.update(exactTab.id, { active: true });
  } else if (reusableTab) {
    opened = await chrome.tabs.update(reusableTab.id, { url: targetUrl, active: true });
  } else {
    opened = await chrome.tabs.create({ url: targetUrl, active: true });
  }
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const current = await chrome.tabs.get(opened.id);
    if (current.status === "complete" && current.url?.startsWith("https://gemini.google.com/")) return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Gemini Chat chưa tải xong sau 90 giây");
}

async function waitReady(tabId, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (pong?.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Tab Flow chưa sẵn sàng hoặc chưa đăng nhập");
}

async function inspectImageCandidate(message) {
  let viewerTab;
  try {
    viewerTab = await chrome.tabs.create({ url: message.url, active: true });
    const started = Date.now();
    while (Date.now() - started < 60000) {
      const current = await chrome.tabs.get(viewerTab.id);
      if (current.status === "complete") break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await ensureReady(viewerTab.id);
    return await chrome.tabs.sendMessage(viewerTab.id, {
      type: "INSPECT_IMAGE_CANDIDATE",
      prompt: message.prompt,
      jobId: message.jobId,
      index: message.index,
      output: message.output
    });
  } finally {
    if (viewerTab?.id) await chrome.tabs.remove(viewerTab.id).catch(() => {});
  }
}

async function ensureReady(tabId) {
  try {
    await waitReady(tabId, 15000);
  } catch {
    // A Flow tab opened before this unpacked extension was installed has no
    // content script. Reloading injects it without asking the user to do so.
    await chrome.tabs.reload(tabId);
    await waitReady(tabId, 60000);
  }
}

async function poll(lane) {
  if (busyLanes[lane]) return;
  // Reserve the worker before the first await. Several startup/alarm/manual
  // poll events can arrive together; reserving later allowed all of them to
  // pass the guard and lease multiple jobs to one Chrome tab.
  busyLanes[lane] = true;
  let task;
  try {
    const cfg = await config();
    if (!cfg.enabled || !cfg.apiKey) return;
    const { blockedLanes = {} } = await chrome.storage.local.get("blockedLanes");
    const laneBlock = blockedLanes[lane];
    if (laneBlock && !canRetryLane(laneBlock)) return;
    const types = [lane];
    ({ task } = await api("/extension/claim", { workerId: `${cfg.workerId}-${lane}`, types }));
    if (!task) {
      if (laneBlock) {
        const { [lane]: removed, ...remainingBlocks } = blockedLanes;
        await chrome.storage.local.set({ blockedLanes: remainingBlocks });
      }
      return;
    }
    if (task.referenceImageUrl) task.referenceImageDataUrl = await referenceDataUrl(task.referenceImageUrl);
    let tab = task.type === "chat"
      ? await geminiTab(task.chatUrl, task.newConversation && task.index === 0)
      : await flowTab(task.mode === "extend" ? task.sourceFlowUrl : task.projectUrl, task.type);
    // flowTab normally prefers the configured project and may intentionally
    // return to its gallery. Native video extension is different: the scene
    // URL is the input, so always restore that exact URL before messaging the
    // content script, even when this lane reused an older Flow tab.
    if (task.type === "video" && task.mode === "extend") {
      tab = await chrome.tabs.update(tab.id, { url: task.sourceFlowUrl, active: true });
    }
    await ensureReady(tab.id);
    let result = await chrome.tabs.sendMessage(tab.id, { type: task.type === "chat" ? "CHAT" : "GENERATE", task });
    if (!result?.ok) throw new Error(result?.error || "Content script xử lý thất bại");
    if (task.type === "video" && task.mode === "extend") {
      if (!result.prepared || !result.flowUrl) throw new Error("Flow chưa trả về scene video nối để xác minh");
      // A continuation is successful only when it survives a hard reload of
      // the exact scene. This rejects Flow's provisional timeline state, which
      // can look complete for a few seconds and then disappear.
      await chrome.tabs.reload(tab.id);
      await ensureReady(tab.id);
      result = await chrome.tabs.sendMessage(tab.id, {
        type: "VERIFY_EXTENDED_VIDEO",
        task: {
          ...task,
          sourceDurationSeconds: result.sourceDurationSeconds,
          expectedDurationSeconds: result.durationSeconds
        }
      });
      if (!result?.ok) throw new Error(result?.error || "Video nối biến mất sau reload");
    }
    await api("/extension/result", { jobId: task.jobId, index: task.index, ...result });
    if (laneBlock) {
      const { blockedLanes: latestBlocks = {} } = await chrome.storage.local.get("blockedLanes");
      const { [lane]: removed, ...remainingBlocks } = latestBlocks;
      await chrome.storage.local.set({ blockedLanes: remainingBlocks });
    }
  } catch (error) {
    if (task) {
      await api("/extension/result", { jobId: task.jobId, index: task.index, ok: false, error: error.message }).catch(() => {});
    }
    const updates = { lastError: error.message, lastRun: new Date().toISOString() };
    if (isSystemicWorkerError(lane, error.message)) {
      const { blockedLanes = {} } = await chrome.storage.local.get("blockedLanes");
      const nextBlock = createLaneBlock(blockedLanes[lane], error.message);
      updates.blockedLanes = {
        ...blockedLanes,
        [lane]: nextBlock
      };
      updates.lastError = `Lane ${lane} tạm dừng đến ${nextBlock.retryAt}: ${error.message}`;
    }
    await chrome.storage.local.set(updates);
  } finally {
    busyLanes[lane] = false;
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("poll", { periodInMinutes: 0.1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("poll", { periodInMinutes: 0.1 }));
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("extension-update", { periodInMinutes: 5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("extension-update", { periodInMinutes: 5 }));

async function reloadWhenUpdaterInstalledNewVersion() {
  try {
    const response = await fetch("http://127.0.0.1:8765/status", { cache: "no-store" });
    if (!response.ok) return;
    const result = await response.json();
    if (result.ok && result.version && result.version !== chrome.runtime.getManifest().version) {
      // Reloading an unpacked extension replaces its service worker but Chrome
      // leaves already-injected content scripts running in open tabs. Refresh
      // Flow/Gemini first so those tabs load the same version from disk.
      const aiTabs = await chrome.tabs.query({ url: [
        "https://labs.google/fx/*",
        "https://gemini.google.com/*"
      ] });
      await Promise.all(aiTabs.map(tab => chrome.tabs.reload(tab.id).catch(() => {})));
      chrome.runtime.reload();
    }
  } catch {
    // The helper is optional; queue processing must continue if it is offline.
  }
}

async function reloadAiTabsAfterRuntimeStart() {
  // An unpacked extension update does not refresh content scripts already
  // running in open pages. Run this from the newly loaded service worker,
  // after chrome.runtime.reload(), so tabs receive the new files rather than
  // another copy from the previous extension runtime.
  const version = chrome.runtime.getManifest().version;
  const { contentScriptsRuntimeVersion } = await chrome.storage.local.get("contentScriptsRuntimeVersion");
  if (contentScriptsRuntimeVersion === version) return;
  await chrome.storage.local.set({ contentScriptsRuntimeVersion: version });
  const aiTabs = await chrome.tabs.query({ url: [
    "https://labs.google/fx/*",
    "https://gemini.google.com/*"
  ] });
  await Promise.all(aiTabs.map(tab => chrome.tabs.reload(tab.id).catch(() => {})));
}
function pollAll() {
  void poll("chat");
  void poll("image");
  void poll("video");
}
// A manual reload of an unpacked extension does not consistently emit
// onInstalled/onStartup. Initialise polling whenever this service worker is
// evaluated so queued jobs resume without requiring a popup button click.
void chrome.alarms.create("poll", { periodInMinutes: 0.1 });
void chrome.alarms.create("extension-update", { periodInMinutes: 5 });
pollAll();
void reloadAiTabsAfterRuntimeStart();
void reloadWhenUpdaterInstalledNewVersion();
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "poll") pollAll();
  if (alarm.name === "extension-update") void reloadWhenUpdaterInstalledNewVersion();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "POLL_NOW") pollAll();
  if (message.type === "INSPECT_IMAGE_URL") {
    inspectImageCandidate(message)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "UPLOAD_MEDIA_BYTES") {
    (async () => {
      if (!message.base64) throw new Error("Video output rỗng");
      const binary = atob(message.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const uploaded = await uploadOutput(
        `/extension/media?jobId=${encodeURIComponent(message.jobId)}&index=${encodeURIComponent(message.index)}&output=${encodeURIComponent(message.output || 1)}`,
        bytes,
        message.contentType === "video/webm" ? "video/webm" : "video/mp4"
      );
      return { ok: true, ...uploaded };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: `Upload video: ${error.message}` }));
    return true;
  }
  if (message.type === "DOWNLOAD_URL") {
    (async () => {
      const mediaLabel = message.mediaType === "video" ? "video" : "ảnh";
      if (!message.url) throw new Error(`Không lấy được URL ${mediaLabel} từ Flow`);
      const mediaType = message.mediaType === "video" ? "video" : "image";
      const source = await fetch(message.url);
      if (!source.ok) throw new Error(`Không đọc được ${mediaLabel} output từ Flow: HTTP ${source.status}`);
      const bytes = await source.arrayBuffer();
      const contentType = String(source.headers.get("content-type") || "image/png").split(";")[0];
      const uploaded = await uploadOutput(
        `/extension/media?jobId=${encodeURIComponent(message.jobId)}&index=${encodeURIComponent(message.index)}&output=${encodeURIComponent(message.output || 1)}`,
        bytes,
        contentType
      );
      const id = await chrome.downloads.download({
        url: message.url,
        filename: `flow-${mediaType}s/flow-${Date.now()}-${message.output || 1}.png`,
        conflictAction: "uniquify",
        saveAs: false
      });
      const started = Date.now();
      while (Date.now() - started < 60000) {
        const [item] = await chrome.downloads.search({ id });
        if (item?.state === "complete") return {
          ok: true,
          filename: item.filename,
          imageUrl: uploaded.imageUrl,
          mediaUrl: uploaded.mediaUrl,
          objectKey: uploaded.objectKey
        };
        if (item?.state === "interrupted") throw new Error(item.error || "Chrome download bị gián đoạn");
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("Chrome download URL quá 60 giây");
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "FIND_VIDEO_DOWNLOAD_UPLOAD") {
    (async () => {
      // Do one short lookup per message. A Manifest V3 service worker may be
      // suspended while a single message waits for a long browser download.
      // The Flow content script polls this operation instead.
      const items = await chrome.downloads.search({
        startedAfter: new Date(message.since - 1000).toISOString(),
        orderBy: ["-startTime"],
        limit: 20
      });
      const item = items.find(entry => {
        const name = `${entry.filename || ""} ${entry.url || ""} ${entry.finalUrl || ""}`;
        return entry.state === "complete" && !entry.error && /\.mp4(?:[\s?]|$)|flow-content\.google\/video\//i.test(name);
      });
      if (!item) {
        const interrupted = items.find(entry => entry.state === "interrupted");
        if (interrupted) throw new Error(interrupted.error || "Chrome download video bị gián đoạn");
        return { ok: true, pending: true };
      }
      const resolvedUrl = item.finalUrl || item.url;
      const source = await fetch(resolvedUrl, { credentials: "omit" });
      if (!source.ok) throw new Error(`Không đọc được video đã tải từ Flow: HTTP ${source.status}`);
      const bytes = await source.arrayBuffer();
      const reported = String(source.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const contentType = reported === "video/webm" ? "video/webm" : "video/mp4";
      const uploaded = await uploadOutput(
        `/extension/media?jobId=${encodeURIComponent(message.jobId)}&index=${encodeURIComponent(message.index)}&output=${encodeURIComponent(message.output || 1)}`,
        bytes,
        contentType
      );
      return {
        ok: true,
        pending: false,
        filename: item.filename,
        mediaUrl: uploaded.mediaUrl,
        objectKey: uploaded.objectKey
      };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "WAIT_DOWNLOAD") {
    (async () => {
      const started = Date.now();
      while (Date.now() - started < 30000) {
        const items = await chrome.downloads.search({
          startedAfter: new Date(message.since).toISOString(),
          orderBy: ["-startTime"],
          limit: 10
        });
        const item = items.find(entry => entry.state === "complete" && !entry.error);
        if (item) return { ok: true, filename: item.filename };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("Chrome không xác nhận file tải xuống sau 30 giây");
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "UPLOAD_FILE_POINT") {
    const target = { tabId: sender.tab?.id };
    (async () => {
      if (!target.tabId) throw new Error("Không xác định được tab Flow");
      const downloadId = await chrome.downloads.download({
        url: message.dataUrl,
        filename: `flow-images/references/${message.filename}`,
        conflictAction: "uniquify",
        saveAs: false
      });
      let localPath = "";
      const downloadStarted = Date.now();
      while (Date.now() - downloadStarted < 30000) {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item?.state === "complete") {
          localPath = item.filename;
          break;
        }
        if (item?.state === "interrupted") throw new Error(item.error || "Không lưu được ảnh tham chiếu tạm");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!localPath) throw new Error("Lưu ảnh tham chiếu tạm quá 30 giây");

      await chrome.debugger.attach(target, "1.3");
      let resolveChooser;
      const chooserOpened = new Promise(resolve => { resolveChooser = resolve; });
      const onDebuggerEvent = (source, method, params) => {
        if (source.tabId === target.tabId && method === "Page.fileChooserOpened") {
          resolveChooser(params || {});
        }
      };
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      try {
        // Intercept the chooser before clicking so macOS never opens its native
        // dialog. CDP exposes the exact input as backendNodeId; assigning files
        // to that node also completes the chooser.
        await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });
        const point = { x: message.x, y: message.y, button: "left", clickCount: 1 };
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...point });
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point });

        const chooser = await Promise.race([
          chooserOpened,
          new Promise(resolve => setTimeout(() => resolve(null), 5000))
        ]);
        if (chooser) {
          if (!chooser.backendNodeId) throw new Error("Flow mở file chooser nhưng Chrome không trả backendNodeId");
          await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
            files: [localPath],
            backendNodeId: chooser.backendNodeId
          });
          return { ok: true, filename: localPath };
        }

        // Fallback for Chrome builds that do not forward fileChooserOpened to
        // extension debuggers: locate the live input created by Flow.
        let fileNodeId = 0;
        const chooserStarted = Date.now();
        while (Date.now() - chooserStarted < 15000 && !fileNodeId) {
          const root = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
          const matches = await chrome.debugger.sendCommand(target, "DOM.querySelectorAll", {
            nodeId: root.root.nodeId,
            selector: 'input[type="file"]'
          });
          fileNodeId = matches.nodeIds?.[0] || 0;
          if (!fileNodeId) await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!fileNodeId) throw new Error("Không tìm thấy input file của Flow sau khi mở hộp chọn file");
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files: [localPath], nodeId: fileNodeId });
        return { ok: true, filename: localPath };
      } finally {
        chrome.debugger.onEvent.removeListener(onDebuggerEvent);
        await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
        await chrome.debugger.detach(target).catch(() => {});
      }
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "TYPE_TEXT" || message.type === "CLICK_POINT" || message.type === "PRESS_ENTER") {
    const target = { tabId: sender.tab?.id };
    (async () => {
      if (!target.tabId) throw new Error("Không xác định được tab Flow");
      await chrome.debugger.attach(target, "1.3");
      try {
        if (message.type === "TYPE_TEXT") {
          // Flow uses a Slate editor. Input.insertText changes what is painted,
          // but does not update Slate's value, so its Generate button stays
          // disabled. Send real keyboard events, as Chrome does for manual input.
          const { os } = await chrome.runtime.getPlatformInfo();
          const selectModifier = os === "mac" ? 4 : 2; // Meta on macOS, Ctrl elsewhere.
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65, modifiers: selectModifier
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65, modifiers: selectModifier
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Backspace", code: "Backspace",
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Backspace", code: "Backspace",
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
          });
          if (message.bulk) {
            // Gemini uses Quill and accepts CDP's native bulk insertion. This
            // is faster and avoids partial/duplicated long prompts.
            await chrome.debugger.sendCommand(target, "Input.insertText", {
              text: String(message.text || "")
            });
            return { ok: true };
          }
          for (const character of Array.from(message.text || "")) {
            if (character === "\n") {
              await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
                type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13
              });
              await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
                type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13
              });
              continue;
            }
            const isLetter = /^[a-z]$/i.test(character);
            const isDigit = /^\d$/.test(character);
            const code = character === " " ? "Space" :
              isLetter ? `Key${character.toUpperCase()}` :
              isDigit ? `Digit${character}` : "";
            const virtualKey = character === " " ? 32 :
              isLetter ? character.toUpperCase().charCodeAt(0) :
              isDigit ? character.charCodeAt(0) : 0;
            // A lone CDP `char` event paints text but is not sufficient for
            // every Flow editor build. Mirror a physical key press exactly:
            // keydown -> char -> keyup for every character (including Space).
            await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
              type: "rawKeyDown", key: character === " " ? " " : character,
              code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey
            });
            await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
              type: "char", text: character, unmodifiedText: character
            });
            await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
              type: "keyUp", key: character === " " ? " " : character,
              code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey
            });
          }
        } else if (message.type === "CLICK_POINT") {
          const point = { x: message.x, y: message.y, button: "left", clickCount: 1 };
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...point });
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
        } else {
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
          });
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "keyUp", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
          });
        }
        return { ok: true };
      } finally {
        await chrome.debugger.detach(target).catch(() => {});
      }
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

// An unpacked-extension reload starts a fresh service worker but does not
// always emit onInstalled/onStartup. Start both lanes immediately so the
// user does not have to open the popup and press "Chạy ngay".
chrome.alarms.create("poll", { periodInMinutes: 0.1 });
pollAll();
