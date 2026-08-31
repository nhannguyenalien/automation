const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = element => element && element.getClientRects().length > 0;
const nodeText = element => (element?.innerText || element?.textContent || "").trim();
const editorText = element => element?.value ?? nodeText(element);
const comparableText = value => String(value || "")
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
  .replace(/\u00A0/g, " ")
  .replace(/\s+/g, " ")
  .trim();

async function waitFor(find, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = find();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Không tìm thấy ${label} sau ${Math.round(timeout / 1000)} giây`);
}

function responseNodes() {
  const selectors = [
    "model-response message-content",
    'model-response [class*="model-response-text"]',
    '[data-test-id="model-response"] message-content',
    ".response-content message-content"
  ];
  let nodes = [...document.querySelectorAll(selectors.join(","))].filter(visible);
  // Gemini changes this internal markup frequently. The stable custom element
  // is a better fallback than timing out when message-content is renamed.
  if (!nodes.length) nodes = [...document.querySelectorAll("model-response")].filter(visible);
  // Keep the innermost content node so the accessibility label
  // ("Gemini đã nói") is not returned as part of the API response.
  return nodes.filter((node, index) => !nodes.some((child, childIndex) => childIndex !== index && node.contains(child)));
}

function responseText(element) {
  return nodeText(element).replace(/^(?:Gemini (?:đã nói|said))\s*/i, "").trim();
}

function responseIsGenerating() {
  return [...document.querySelectorAll("button")].some(button => {
    const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${nodeText(button)}`;
    return visible(button) && /stop response|stop generating|dừng phản hồi|ngừng (?:tạo )?(?:câu trả lời|phản hồi|trả lời)/i.test(label);
  });
}

function promptEditor() {
  const candidates = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(element => {
    if (!visible(element) || element.getAttribute("contenteditable") === "false") return false;
    // Quill keeps an off-screen `.ql-clipboard` contenteditable below the real
    // composer. Choosing it makes text appear in the clipboard helper while
    // Gemini's Send button remains disabled.
    if (element.classList.contains("ql-clipboard")) return false;
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`;
    return /prompt|message|ask gemini|nhập câu lệnh|đặt câu hỏi|tin nhắn/i.test(label) || element.closest("rich-textarea");
  });
  return candidates.sort((a, b) => {
    const aTextbox = a.getAttribute("role") === "textbox" ? 1 : 0;
    const bTextbox = b.getAttribute("role") === "textbox" ? 1 : 0;
    return bTextbox - aTextbox || b.getBoundingClientRect().top - a.getBoundingClientRect().top;
  })[0] || null;
}

function sendButton(editor) {
  const buttons = [...document.querySelectorAll("button")].filter(button => {
    if (!visible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${nodeText(button)}`;
    return /send message|send prompt|gửi tin nhắn|gửi câu lệnh/i.test(label);
  });
  if (!buttons.length) return null;
  const rect = editor.getBoundingClientRect();
  return buttons.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (Math.abs(ar.bottom - rect.bottom) + Math.abs(ar.right - rect.right)) -
      (Math.abs(br.bottom - rect.bottom) + Math.abs(br.right - rect.right));
  })[0];
}

async function clickLikeUser(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const result = await chrome.runtime.sendMessage({
    type: "CLICK_POINT",
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  });
  if (!result?.ok) throw new Error(result?.error || "Không click được Gemini");
}

function responseStarted(editor, beforeNodes, beforeLatestText) {
  if (!comparableText(nodeText(editor))) return true;
  const candidates = responseNodes();
  const latest = candidates[candidates.length - 1];
  return Boolean(latest && (candidates.length > beforeNodes.length ||
    !beforeNodes.includes(latest) || responseText(latest) !== beforeLatestText));
}

async function waitBrieflyForSubmit(editor, beforeNodes, beforeLatestText, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (responseStarted(editor, beforeNodes, beforeLatestText)) return true;
    await sleep(150);
  }
  return false;
}

async function fillPrompt(prompt, attempts = 2) {
  const expected = comparableText(prompt);
  let observed = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Gemini can replace the Quill editor node after a model change or a long
    // native insert. Re-query it on every attempt instead of retaining a stale
    // reference from the previous render.
    const editor = await waitFor(promptEditor, 60000, "ô nhập Gemini (hãy kiểm tra đăng nhập)");
    await clickLikeUser(editor);
    const typed = await chrome.runtime.sendMessage({ type: "TYPE_TEXT", text: prompt, bulk: true });
    if (!typed?.ok) throw new Error(typed?.error || "Không nhập được prompt Gemini");

    const started = Date.now();
    while (Date.now() - started < 20000) {
      const currentEditor = promptEditor() || editor;
      observed = comparableText(editorText(currentEditor));
      if (observed === expected) return currentEditor;
      await sleep(250);
    }
  }

  throw new Error(
    `Prompt Gemini không khớp sau ${attempts} lần nhập ` +
    `(độ dài mong đợi ${expected.length}, thực tế ${observed.length})`
  );
}

async function selectModel(model) {
  const requested = !model || model === "default" ? "3.5-flash-lite" : model;
  const labels = {
    // Gemini currently renders this label as `3.5 Flash-Lite`. Accept both
    // the hyphenated UI label and the older whitespace-only variant.
    "3.5-flash-lite": /3\.5\s*Flash(?:\s*[-–—]\s*|\s+)Lite/i,
    "3.1-pro": /3\.1\s*Pro/i
  };
  const selectedLabels = {
    "3.5-flash-lite": /(?:hiện tại là|currently)?\s*(?:Gemini\s*)?3\.5\s*Flash(?:\s*[-–—]\s*|\s+)Lite/i,
    "3.1-pro": /(?:hiện tại là|currently)\s+Pro\b|^\s*Pro\b/i
  };
  const wanted = labels[requested];
  const selected = selectedLabels[requested] || wanted;
  if (!wanted) throw new Error(`Model Gemini không hỗ trợ: ${requested}`);

  const picker = await waitFor(() => [...document.querySelectorAll("button")].find(button => {
    const label = `${button.getAttribute("aria-label") || ""} ${nodeText(button)}`;
    return visible(button) && /mở công cụ chọn chế độ|open mode selector/i.test(label);
  }), 15000, "nút chọn model Gemini");
  if (selected.test(`${picker.getAttribute("aria-label") || ""} ${nodeText(picker)}`)) return;

  await clickLikeUser(picker);
  const option = await waitFor(() => [...document.querySelectorAll(
    '[role="menuitem"],[role="menuitemradio"],[role="option"]'
  )].find(item =>
    visible(item) && wanted.test(nodeText(item))
  ), 10000, `model ${requested}`);
  await clickLikeUser(option);
  // The current Gemini picker displays a mode name (for example `Nhanh` or
  // `Pro Mở rộng`) after selection rather than the versioned model label.
  // Clicking the exact versioned menu item and observing the menu close is the
  // reliable confirmation across both the old and current picker UIs.
  await waitFor(
    () => selected.test(`${picker.getAttribute("aria-label") || ""} ${nodeText(picker)}`) ||
      !visible(option) || picker.getAttribute("aria-expanded") === "false",
    15000,
    `xác nhận model ${requested}`
  );
}

async function chat(task) {
  await selectModel(task.model);
  const editor = await fillPrompt(task.prompt);

  const beforeNodes = responseNodes();
  const beforeLatestText = responseText(beforeNodes[beforeNodes.length - 1]);
  const submit = await waitFor(() => sendButton(editor), 15000, "nút Gửi của Gemini");
  await clickLikeUser(submit);
  // A CDP coordinate click can occasionally be acknowledged without Gemini
  // accepting it (notably after a tab reload). Verify submission and use two
  // progressively stronger fallbacks, while checking between each attempt so
  // the prompt can never be sent twice.
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeLatestText)) {
    submit.click();
  }
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeLatestText)) {
    await clickLikeUser(editor);
    const pressed = await chrome.runtime.sendMessage({ type: "PRESS_ENTER" });
    if (!pressed?.ok) throw new Error(pressed?.error || "Không nhấn được Enter trong Gemini");
  }
  if (!await waitBrieflyForSubmit(editor, beforeNodes, beforeLatestText, 5000)) {
    throw new Error("Gemini chưa nhận thao tác Gửi sau click và Enter");
  }

  let lastText = "";
  let stableSince = 0;
  const response = await waitFor(() => {
    const candidates = responseNodes();
    const latest = candidates[candidates.length - 1];
    if (!latest) return null;
    const current = responseText(latest);
    const isNewResponse = candidates.length > beforeNodes.length ||
      !beforeNodes.includes(latest) || current !== beforeLatestText;
    if (!current || !isNewResponse) return null;
    if (current !== lastText) {
      lastText = current;
      stableSince = Date.now();
      return null;
    }
    return !responseIsGenerating() && Date.now() - stableSince >= 2500 ? current : null;
  }, Math.max(30000, Number(task.timeoutMs || 300000)), "câu trả lời Gemini hoàn chỉnh");

  return { ok: true, text: response, conversationUrl: location.href };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") return void sendResponse({ ok: true, app: "gemini" });
  if (message.type !== "CHAT") return;
  chat(message.task).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
