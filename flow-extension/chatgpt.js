const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = element => element && element.getClientRects().length > 0;
const nodeText = element => (element?.innerText || element?.textContent || "").trim();
const comparableText = value => String(value || "")
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
  .replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

async function waitFor(find, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = find();
    if (value) return value;
    await sleep(400);
  }
  throw new Error(`Không tìm thấy ${label} sau ${Math.round(timeout / 1000)} giây`);
}

function promptEditor() {
  return document.querySelector('#prompt-textarea[contenteditable="true"]') ||
    [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')]
      .find(element => visible(element) && /chat with chatgpt|message chatgpt|nhắn.*chatgpt/i.test(
        `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`
      ));
}

function responseNodes() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
}

function responseText(element) {
  const content = element?.querySelector(".markdown") || element;
  return nodeText(content).replace(/^ChatGPT (?:said|đã nói):?\s*/i, "").trim();
}

function responseIsGenerating() {
  return Boolean(document.querySelector('button[data-testid="stop-button"]')) ||
    [...document.querySelectorAll("button")].some(button => visible(button) &&
      /stop generating|stop response|dừng tạo|ngừng tạo/i.test(
        `${button.getAttribute("aria-label") || ""} ${nodeText(button)}`
      ));
}

function generatedImages() {
  return globalThis.ChatGPTImageDetector?.generatedImages(document) || [];
}

function createImageButton() {
  return [...document.querySelectorAll("button")].find(button => visible(button) &&
    /create an image or sticker|create image|tạo ảnh/i.test(
      `${button.getAttribute("aria-label") || ""} ${nodeText(button)}`
    ));
}

function onImagePage() {
  return location.pathname === "/images" || location.pathname.startsWith("/images/");
}

function imageLimitError() {
  const selectors = [
    '[role="alert"]',
    '[data-message-author-role="assistant"]',
    'main'
  ];
  const text = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
    .filter(visible).map(nodeText).join("\n");
  if (/(?:\b0|\bno)\s+images?\s+left|out of image creations|wait for (?:your usage to reset|more tomorrow)|image creation limit|reached (?:your|the) image limit|hết lượt tạo ảnh|đạt giới hạn tạo ảnh|thử lại vào ngày mai/i.test(text)) {
    const reset = text.match(/(?:usage to reset at|reset at|try again (?:tomorrow )?at)\s+([^,.\n]{1,30})/i)?.[1]?.trim();
    const error = new Error(`Tài khoản ChatGPT đã hết lượt tạo ảnh${reset ? `; quota dự kiến reset lúc ${reset}` : "; hãy chờ quota được cấp lại rồi thử tiếp"}`);
    error.code = "provider_quota";
    error.retryable = false;
    return error;
  }
  return null;
}

function sendButton() {
  return document.querySelector('button[data-testid="send-button"]:not([disabled])') ||
    [...document.querySelectorAll("button")].find(button => visible(button) && !button.disabled &&
      /send prompt|send message|gửi câu lệnh|gửi tin nhắn/i.test(
        `${button.getAttribute("aria-label") || ""} ${nodeText(button)}`
      ));
}

async function clickLikeUser(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const result = await chrome.runtime.sendMessage({
    type: "CLICK_POINT",
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  });
  if (!result?.ok) throw new Error(result?.error || "Không click được ChatGPT");
}

async function fillPrompt(prompt) {
  const editor = await waitFor(promptEditor, 60000, "ô nhập ChatGPT (hãy kiểm tra đăng nhập)");
  await clickLikeUser(editor);
  const typed = await chrome.runtime.sendMessage({ type: "TYPE_TEXT", text: prompt, bulk: true });
  if (!typed?.ok) throw new Error(typed?.error || "Không nhập được prompt ChatGPT");
  await waitFor(() => comparableText(nodeText(promptEditor())) === comparableText(prompt), 20000, "prompt ChatGPT đầy đủ");
  return promptEditor();
}

function responseStarted(editor, beforeNodes, beforeText) {
  if (!comparableText(nodeText(editor))) return true;
  const nodes = responseNodes();
  const latest = nodes.at(-1);
  return Boolean(latest && (nodes.length > beforeNodes.length || !beforeNodes.includes(latest) || responseText(latest) !== beforeText));
}

async function waitBrieflyForSubmit(editor, beforeNodes, beforeText, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (responseStarted(editor, beforeNodes, beforeText)) return true;
    await sleep(150);
  }
  return false;
}

async function chat(task) {
  const editor = await fillPrompt(task.prompt);
  const beforeNodes = responseNodes();
  const beforeText = responseText(beforeNodes.at(-1));
  const submit = await waitFor(sendButton, 15000, "nút Gửi của ChatGPT");
  await clickLikeUser(submit);
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeText)) submit.click();
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeText)) {
    await clickLikeUser(editor);
    const pressed = await chrome.runtime.sendMessage({ type: "PRESS_ENTER" });
    if (!pressed?.ok) throw new Error(pressed?.error || "Không nhấn được Enter trong ChatGPT");
  }
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeText, 5000)) {
    throw new Error("ChatGPT chưa nhận thao tác Gửi sau click và Enter");
  }

  let lastText = "";
  let stableSince = 0;
  const response = await waitFor(() => {
    const nodes = responseNodes();
    const latest = nodes.at(-1);
    if (!latest) return null;
    const current = responseText(latest);
    const isNew = nodes.length > beforeNodes.length || !beforeNodes.includes(latest) || current !== beforeText;
    if (!current || !isNew) return null;
    if (current !== lastText) {
      lastText = current;
      stableSince = Date.now();
      return null;
    }
    return !responseIsGenerating() && Date.now() - stableSince >= 2500 ? current : null;
  }, Math.max(30000, Number(task.timeoutMs || 300000)), "câu trả lời ChatGPT hoàn chỉnh");
  return { ok: true, text: response, conversationUrl: location.href };
}

async function generateImage(task) {
  const initialLimitError = imageLimitError();
  if (initialLimitError) throw initialLimitError;
  const beforeKeys = new Set(generatedImages().map(image => image.key));
  if (!onImagePage()) {
    const imageMode = await waitFor(createImageButton, 30000, "nút tạo ảnh ChatGPT");
    await clickLikeUser(imageMode);
  }
  const editor = await fillPrompt(task.prompt);
  const filledLimitError = imageLimitError();
  if (filledLimitError) throw filledLimitError;
  const beforeNodes = responseNodes();
  const beforeText = responseText(beforeNodes.at(-1));
  const submit = await waitFor(() => {
    const limitError = imageLimitError();
    if (limitError) throw limitError;
    return sendButton();
  }, 15000, "nút Gửi của ChatGPT");
  await clickLikeUser(submit);
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeText)) submit.click();
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeText, 5000)) {
    throw new Error("ChatGPT chưa nhận yêu cầu tạo ảnh");
  }

  let candidateKey = "";
  let candidateUrl = "";
  let stableSince = 0;
  const imageUrl = await waitFor(() => {
    const current = generatedImages().find(image => !beforeKeys.has(image.key));
    if (!current) {
      const limitError = imageLimitError();
      if (limitError) throw limitError;
      return null;
    }
    candidateUrl = current.url;
    if (current.key !== candidateKey) {
      candidateKey = current.key;
      stableSince = Date.now();
      return null;
    }
    return !responseIsGenerating() && Date.now() - stableSince >= 2500 ? candidateUrl : null;
  }, Math.max(60000, Number(task.timeoutMs || 300000)), "ảnh ChatGPT hoàn chỉnh");

  const downloaded = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_URL", url: imageUrl, mediaType: "image", provider: "chatgpt",
    jobId: task.jobId, index: task.index, output: 1
  });
  if (!downloaded?.ok) throw new Error(downloaded?.error || "Không tải được ảnh ChatGPT");
  return {
    ok: true, downloaded: true, filename: downloaded.filename,
    imageUrl: downloaded.imageUrl, imageUrls: [downloaded.imageUrl],
    objectKey: downloaded.objectKey, conversationUrl: location.href
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") return void sendResponse({ ok: true, app: "chatgpt" });
  if (!new Set(["CHAT", "GENERATE_IMAGE"]).has(message.type)) return;
  const action = message.type === "GENERATE_IMAGE" ? generateImage : chat;
  action(message.task).then(sendResponse).catch(error => sendResponse({
    ok: false,
    error: error.message,
    errorCode: error.code || null,
    retryable: error.retryable !== false
  }));
  return true;
});
