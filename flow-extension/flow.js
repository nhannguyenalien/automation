const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = element => element && element.getClientRects().length > 0;
const text = element => (element?.innerText || element?.textContent || "").trim();
const labelText = element => `${element?.getAttribute?.("aria-label") || ""} ${element?.getAttribute?.("title") || ""} ${text(element)}`.trim();

async function waitFor(find, timeout = 180000, label = "phần tử") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await find();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Không tìm thấy ${label} sau ${Math.round(timeout / 1000)} giây`);
}

function clickByText(pattern, selector = "button,[role=button],[role=tab]") {
  // Flow renders some controls inside nested web components. Search those
  // roots too, then prefer the shortest label so `x1` selects the menu option
  // instead of the large mode button whose full label also ends in `x1`.
  const target = deepElements(selector)
    .filter(el => visible(el) && pattern.test(labelText(el)))
    .sort((a, b) => labelText(a).length - labelText(b).length)[0];
  if (!target) return false;
  target.click();
  return true;
}

async function waitAndClickByText(pattern, selector, timeout, label) {
  return waitFor(() => clickByText(pattern, selector), timeout, label);
}

async function inputLikeUser(editor, value) {
  await clickLikeUser(editor);
  editor.focus();
  const response = await chrome.runtime.sendMessage({ type: "TYPE_TEXT", text: value });
  if (!response?.ok) throw new Error(response?.error || "Không nhập được prompt");
  await sleep(500);
}

async function clickLikeUser(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  await sleep(150);
  const rect = element.getBoundingClientRect();
  const response = await chrome.runtime.sendMessage({
    type: "CLICK_POINT",
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  });
  if (!response?.ok) throw new Error(response?.error || "Không click được nút Tạo");
}

async function readFlowMediaBlob(url, timeout = 60000) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Không đọc được blob video Flow sau 60 giây"));
    }, timeout);
    function receive(event) {
      if (event.source !== window || event.data?.type !== "FLOW_MEDIA_BLOB_RESULT" || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (!event.data.ok) reject(new Error(`Không đọc được blob video Flow: ${event.data.error}`));
      else resolve({ buffer: event.data.buffer, contentType: event.data.contentType });
    }
    window.addEventListener("message", receive);
    window.postMessage({ type: "FLOW_READ_MEDIA_BLOB", id, url }, "*");
  });
}

async function uploadFlowVideo(task, mediaUrl) {
  const { buffer, contentType: reported } = await readFlowMediaBlob(mediaUrl);
  const contentType = String(reported || "").split(";")[0].trim().toLowerCase() === "video/webm"
    ? "video/webm" : "video/mp4";
  // In Manifest V3 a content-script fetch uses the page's CORS context even
  // when the extension has host_permissions. Pass the bytes to the service
  // worker, whose cross-origin request is covered by those permissions.
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const uploaded = await chrome.runtime.sendMessage({
    type: "UPLOAD_MEDIA_BYTES",
    jobId: task.jobId,
    index: task.index,
    output: 1,
    contentType,
    base64: btoa(binary)
  });
  if (!uploaded?.ok) throw new Error(uploaded?.error || "Service worker không upload được video");
  return uploaded;
}

function findSubmit(editor) {
  const buttons = [...document.querySelectorAll("button")].filter(el => {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${text(el)}`;
    if (/add_2|Add media|Thêm nội dung nghe nhìn/i.test(label)) return false;
    return /arrow_forward/i.test(label) || /^(?:\s*)(?:Tạo|Create|Generate)(?:\s*)$/i.test(label);
  });
  if (!buttons.length) return null;
  const editorRect = editor.getBoundingClientRect();
  return buttons.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const ad = Math.abs(ar.bottom - editorRect.bottom) + Math.abs(ar.right - editorRect.right);
    const bd = Math.abs(br.bottom - editorRect.bottom) + Math.abs(br.right - editorRect.right);
    return ad - bd;
  })[0];
}

function clickableResult(el) {
  return el.closest('a,button,[role="button"]') || el;
}

function normalizedPrompt(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function viewerMatchesPrompt(prompt) {
  const expected = normalizedPrompt(prompt);
  if (!expected) return false;
  // Flow does not expose the prompt on gallery cards. It does expose the full
  // prompt in the image viewer, even while the visual text is collapsed.
  return normalizedPrompt(document.body.innerText).includes(expected);
}

function generatedLinks() {
  return [...document.querySelectorAll('a[href]')].filter(el => {
    if (!visible(el)) return false;
    const image = el.querySelector("img");
    if (!image || !visible(image) || !(image.currentSrc || image.src)) return false;
    const labels = [labelText(el), labelText(image)];
    let context = el.parentElement;
    for (let depth = 0; context && depth < 4; depth += 1, context = context.parentElement) {
      // Stop before reaching the shared gallery container. Its text may
      // include a neighbouring Veo card and would incorrectly reject this
      // otherwise valid image card.
      if (context.querySelectorAll?.('a[href]').length > 1) break;
      labels.push(labelText(context));
      if (context.matches?.('article,[role="listitem"],[role="gridcell"],li')) break;
    }
    const label = labels.join(" ");
    // A video thumbnail is still an <img>. Never let it enter the image lane,
    // even when its card is temporarily mounted inside the Images library.
    if (el.querySelector("video") || /Veo|video|play_circle|Hình thu nhỏ video|Phát|Play/i.test(label)) return false;
    const rect = image?.getBoundingClientRect();
    return /Hình ảnh được tạo|Generated image|Open image/i.test(label) || (rect.width >= 200 && rect.height >= 150);
  });
}

function imageLinkSnapshot() {
  const hrefs = new Set();
  const sources = new Set();
  for (const link of generatedLinks()) {
    hrefs.add(link.href);
    const image = link.querySelector("img");
    if (image?.currentSrc || image?.src) sources.add(image.currentSrc || image.src);
  }
  return { hrefs, sources };
}

async function stableImageBaseline(timeout = 10000, quietMs = 2500) {
  const started = Date.now();
  let lastChangeAt = started;
  let previousKey = "";
  let snapshot = imageLinkSnapshot();
  while (Date.now() - started < timeout) {
    snapshot = imageLinkSnapshot();
    const key = `${[...snapshot.hrefs].sort().join("\n")}\0${[...snapshot.sources].sort().join("\n")}`;
    if (key !== previousKey) {
      previousKey = key;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return snapshot;
    }
    await sleep(250);
  }
  throw new Error("Thư viện ảnh Flow chưa ổn định trước khi tạo; từ chối ghép kết quả không chắc chắn");
}

function visibleImageDialogs() {
  return deepElements('[role="dialog"],[aria-modal="true"]')
    .filter(dialog => visible(dialog) && !dialog.querySelector("video"));
}

function imageViewerCandidate() {
  const dialogs = visibleImageDialogs()
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });
  const roots = dialogs.length ? dialogs : [document];
  for (const root of roots) {
    const images = [...root.querySelectorAll("img")]
      .filter(image => {
        if (!visible(image)) return false;
        const source = image.currentSrc || image.src || "";
        if (!source) return false;
        const label = `${labelText(image)} ${labelText(image.parentElement)}`;
        if (/Veo|video|play_circle|Hình thu nhỏ video|Phát|Play/i.test(label)) return false;
        const rect = image.getBoundingClientRect();
        // Flow renders the large viewer on a canvas. Its original media URL is
        // exposed by the selected 248x138 result thumbnail beside that canvas.
        // The full prompt has already been matched before this function runs,
        // so accepting a visible image-sized thumbnail is safe and avoids
        // waiting forever for a large <img> that Flow never creates.
        const largeEnough = rect.width >= 200 && rect.height >= 120;
        // The caller has already verified the viewer's full prompt exactly.
        // Flow may preload the viewer-sized URL while still in the gallery, so
        // requiring a new src here can reject the correct image. At this point
        // the exact prompt + a large, visible, non-video image is the stronger
        // and more stable correlation signal.
        return largeEnough;
      })
      .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) -
        (a.getBoundingClientRect().width * a.getBoundingClientRect().height));
    if (images[0]) return images[0];
  }
  return null;
}

function deepElements(selector, root = document) {
  const found = [...root.querySelectorAll(selector)];
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) found.push(...deepElements(selector, element.shadowRoot));
  }
  return found;
}

function referenceDialog() {
  return deepElements('[role="dialog"],[aria-modal="true"]').find(visible) || null;
}

function referenceInput() {
  const modal = referenceDialog();
  const inputs = modal
    ? [...modal.querySelectorAll('input[type="file"]')]
    : deepElements('input[type="file"]');
  return inputs.find(el => (el.accept || "").trim() === "image/*") || inputs.find(el => {
    return !el.accept || /image|png|jpe?g|webp/i.test(el.accept);
  }) || null;
}

function buttonWithLabel(pattern) {
  return deepElements('button,[role="button"],[role="tab"],label').find(el => {
    if (!visible(el)) return false;
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${text(el)}`;
    return pattern.test(label.trim());
  });
}

async function attachReference(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const extension = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
  const filename = `reference-${Date.now()}.${extension}`;

  const addButton = await waitFor(
    () => buttonWithLabel(/^(?:add_2\s*)?(?:Tạo|Add media|Thêm nội dung nghe nhìn)$/i),
    60000,
    "nút + cạnh ô prompt"
  ).catch(() => null);
  if (!addButton) {
    const visibleButtons = deepElements('button,[role="button"]')
      .filter(visible)
      .slice(0, 20)
      .map(el => `${el.getAttribute("aria-label") || ""} ${text(el)}`.trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Không tìm thấy nút + cạnh ô prompt tại ${location.href}. Các nút: ${visibleButtons || "(không có)"}`);
  }
  await clickLikeUser(addButton);
  await sleep(500);

  const uploadButton = await waitFor(() => buttonWithLabel(/(?:Tải nội dung nghe nhìn lên|Upload media)/i), 10000, "nút tải ảnh lên");
  uploadButton.scrollIntoView({ block: "center", inline: "center" });
  await sleep(150);
  const rect = uploadButton.getBoundingClientRect();
  // This menu opens a native file chooser and only creates its file input at
  // click time. Let the extension worker intercept that chooser through CDP
  // and provide a real local file, exactly like a manual selection.
  const upload = await chrome.runtime.sendMessage({
    type: "UPLOAD_FILE_POINT",
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    dataUrl,
    filename
  });
  if (!upload?.ok) throw new Error(upload?.error || "Flow không nhận file ảnh tham chiếu");

  // Flow shows this consent only on the first upload for a Google account.
  const consent = await waitFor(() => buttonWithLabel(/^(?:Tôi đồng ý|I agree)$/i), 5000, "xác nhận upload").catch(() => null);
  if (consent) await clickLikeUser(consent);

  const uploadedOption = await waitFor(() => {
    return deepElements('[role="option"],button').find(el => visible(el) && text(el).includes(filename));
  }, 60000, "ảnh vừa upload trong thư viện");
  await clickLikeUser(uploadedOption);

  const addToPrompt = await waitFor(() => {
    // Material icons can be included in innerText before the translated label,
    // so do not require the label to be the entire button text.
    const button = buttonWithLabel(/(?:Thêm vào câu lệnh|Add to prompt)/i);
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
  }, 30000, "nút Thêm vào câu lệnh");
  await clickLikeUser(addToPrompt);
  await sleep(1000);
}

async function openFlowSection(type) {
  const pattern = type === "video"
    ? /(?:^|\s)(?:Video|Videos)\s*$/i
    : /(?:^|\s)(?:Hình ảnh|Images?|Xem hình ảnh|View images)\s*$/i;
  const section = await waitFor(() => {
    return deepElements('a,button,[role="button"],[role="tab"],[role="link"]')
      .filter(element => {
        if (!visible(element) || !pattern.test(labelText(element))) return false;
        const rect = element.getBoundingClientRect();
        // The mode switch requested here is the project sidebar, not a Video
        // option inside the settings popover or a generated media card.
        return rect.left < Math.min(360, window.innerWidth * 0.3) && rect.top > 80 && rect.height < 100;
      })
      .sort((a, b) => labelText(a).length - labelText(b).length)[0] || null;
  }, 60000, `mục ${type === "video" ? "Video" : "Hình ảnh"} ở sidebar Flow`);

  await clickLikeUser(section);
  await sleep(700);

  // The sidebar only filters the media library. It does not switch the
  // composer from Nano Banana to Veo (or back). `configure` owns that switch
  // after opening the composer's settings popover.
}

async function configure(ratio, type = "image", model = null, outputs = 1, hasReferenceImage = false) {
  // The selected-mode button renders its model, ratio icon and count on
  // separate lines (for example `Nano Banana 2\ncrop_16_9\nx1`). A normal
  // dot does not cross those line breaks, so use an explicit any-character
  // span and include Imagen for accounts where that is the selected model.
  // Flow currently labels the image model `Nano Banana 2`. Keep this matcher
  // structural (mode/model + crop icon + output count) so future model-name
  // changes do not make the whole worker unable to find its settings button.
  const expectedMode = type === "video" ? /Video|Veo/i : /Nano Banana|Imagen|Hình ảnh|Image/i;
  const findModeButton = () => deepElements("button").find(el => {
    const label = labelText(el);
    if (!visible(el) || !/(?:crop_[\d_]+|\d+\s*:\s*\d+)/i.test(label) || !/x\d/i.test(label)) return false;
    const rect = el.getBoundingClientRect();
    return rect.top > window.innerHeight * 0.6 && rect.width < 400 && rect.height < 100;
  });
  const findModeMenu = () => deepElements('[role="menu"],[role="dialog"],[role="listbox"],div')
    .filter(el => {
      const label = labelText(el);
      return visible(el) && /x[1-4]/i.test(label) && /(?:crop_[\d_]+|16\s*:\s*9|9\s*:\s*16|1\s*:\s*1)/i.test(label);
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    })[0] || null;
  let mode = await waitFor(
    findModeButton,
    60000,
    `nút cấu hình ${type === "video" ? "video" : "ảnh"} của Flow`
  );
  await clickLikeUser(mode);
  await sleep(500);

  // Some Flow menu actions replace the whole popover. Re-open the current
  // mode menu whenever the next control is no longer visible.
  async function ensureMenuControl(pattern, label) {
    const selector = '[role="tab"],[role="radio"],[role="option"],[role="menuitem"],[role="button"],button,label';
    const findControl = () => {
      // Flow replaces the complete settings popover when Image/Video or a
      // generation mode is selected. Never retain a menu DOM node across a
      // click: it becomes detached even though the replacement looks the
      // same on screen.
      const currentMenu = findModeMenu();
      if (currentMenu) {
        const scoped = deepElements(selector, currentMenu)
          .find(el => visible(el) && pattern.test(labelText(el)));
        if (scoped) return scoped;
      }

      // Some current Flow builds do not expose a role on the popover root.
      // The individual controls are still accessible, so use the visible
      // lower-screen control as a safe fallback (sidebar items sit higher).
      return deepElements(selector).find(el => {
        if (!visible(el) || !pattern.test(labelText(el))) return false;
        const rect = el.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.35;
      }) || null;
    };

    let control = findControl();
    if (!control) {
      mode = await waitFor(findModeButton, 10000, "nút cấu hình Flow");
      await clickLikeUser(mode);
      await sleep(500);
      await waitFor(findModeMenu, 10000, "menu cấu hình Flow");
    }
    return waitFor(findControl, 10000, label);
  }

  // The media-library sidebar and the composer keep independent state. Flow
  // can therefore show the Hình ảnh sidebar while the composer is still on
  // Video. Always re-select Hình ảnh for image jobs; the model-button label
  // is not a reliable indication immediately after changing sidebar tabs.
  // Video can keep the conditional path because selecting it repeatedly may
  // reset its Thành phần/Khung hình sub-mode.
  if (type === "image" || !expectedMode.test(labelText(mode))) {
    const mediaType = await ensureMenuControl(
      type === "video"
        ? /(?:^|\s)(?:Video|Videos)\s*$/i
        : /(?:^|\s)(?:Hình ảnh|Images?)\s*$/i,
      `loại trình tạo ${type === "video" ? "Video" : "Hình ảnh"}`
    );
    await clickLikeUser(mediaType);
    await sleep(500);
    mode = await waitFor(() => {
      const current = findModeButton();
      return current && expectedMode.test(labelText(current)) ? current : null;
    }, 10000, `trình tạo ${type === "video" ? "Veo" : "ảnh"}`);
  }

  if (type === "video") {
    // Text-to-video uses Thành phần. When a reference image is present, use
    // Khung hình so Flow treats it as the starting frame (an end frame is not
    // required). This exact branch was verified manually with Veo 3.1 Lite.
    const generationMode = await ensureMenuControl(
      hasReferenceImage
        ? /(?:^|\s)(?:Khung hình|Frames?)\s*$/i
        : /(?:^|\s)(?:Thành phần|Ingredients|Components)\s*$/i,
      hasReferenceImage
        ? "chế độ image-to-video Khung hình"
        : "chế độ text-to-video Thành phần"
    );
    await clickLikeUser(generationMode);
    await sleep(400);
  }

  const ratioPattern = new RegExp(`(?:^|\\s)${ratio.replace(":", "\\:")}\\s*$`, "i");
  const ratioControl = await ensureMenuControl(ratioPattern, `tỷ lệ ${ratio}`);
  await clickLikeUser(ratioControl);
  await sleep(400);

  if (type === "video" && model === "veo-3.1-lite") {
    // Follow the order confirmed manually in Flow: Video -> generation mode
    // -> ratio -> model -> x1. Selecting x1 closes the popover, so choose the
    // model first and make x1 the final menu action.
    const modelButton = await ensureMenuControl(/Veo\s*(?:2|3)(?:\.\d+)?/i, "nút chọn model Veo");
    if (!/Veo\s*3\.1\s*[-–—]?\s*(?:Lite|Nhanh)/i.test(labelText(modelButton))) {
      await clickLikeUser(modelButton);
      await sleep(400);
      await waitAndClickByText(
        /Veo\s*3\.1\s*[-–—]?\s*(?:Lite|Nhanh)/i,
        '[role="option"],[role="menuitem"],[role="radio"],[role="button"],button',
        10000,
        "lựa chọn Veo 3.1 Lite"
      );
      await sleep(400);
    }
  }

  if (type === "image") {
    const outputControl = await ensureMenuControl(new RegExp(`(?:^|\\s)x${outputs}\\s*$`, "i"), `số ảnh x${outputs}`);
    await clickLikeUser(outputControl);
    await sleep(400);
  } else {
    // Flow remembers x2-x4 from manual runs. Always force x1 for API video;
    // otherwise a single request can unexpectedly spend 20-40 credits.
    const outputControl = await ensureMenuControl(/(?:^|\s)x1\s*$/i, "số video x1");
    await clickLikeUser(outputControl);
    await sleep(400);
  }

  await waitFor(() => {
    const current = findModeButton();
    if (!current) return null;
    const label = labelText(current);
    return type === "video" ? /Video|Veo/i.test(label) : !/Video|Veo/i.test(label);
  }, 10000, `xác nhận chế độ ${type}`);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function generatedVideoLinks() {
  return [...document.querySelectorAll('a[href]')].filter(link => {
    if (!visible(link)) return false;
    const label = `${link.getAttribute("aria-label") || ""} ${text(link)} ${text(link.parentElement)}`;
    return Boolean(link.querySelector('video')) ||
      /Hình thu nhỏ video|Video thumbnail|Generated video|Video được tạo|play_circle|Phát|Play/i.test(label);
  });
}

function visibleFlowError() {
  const candidates = deepElements('[role="alert"],[role="dialog"],button,p,span,div').filter(visible);
  const patterns = [
    /Selected model is at capacity/i,
    /model.*(?:capacity|quá tải)/i,
    /(?:unusual activity|hoạt động bất thường)/i,
    /(?:couldn.t generate|không thể tạo|không tạo được)/i,
    /(?:not enough|insufficient).*(?:credit|tín dụng)/i,
    /(?:credit|tín dụng).*(?:required|cần|hết)/i
  ];
  for (const element of candidates) {
    const message = text(element).replace(/\s+/g, " ").trim();
    if (message && message.length <= 500 && patterns.some(pattern => pattern.test(message))) return message;
  }
  return null;
}

async function generate(task) {
  const expectedOutputs = task.type === "image" ? Math.max(1, Math.min(4, Number(task.outputs || 1))) : 1;
  const recoverExistingImage = task.type === "image" && Number(task.attempt || 1) > 1;
  await openFlowSection(task.type);
  await configure(
    task.ratio,
    task.type,
    task.model,
    expectedOutputs,
    Boolean(task.referenceImageDataUrl)
  );
  if (task.referenceImageDataUrl) await attachReference(task.referenceImageDataUrl);
  // Uploading/closing the media picker can replace Flow's editor node. Always
  // resolve it again afterwards and choose the lowest visible editor on page.
  const editor = await waitFor(() => [...document.querySelectorAll('[contenteditable="true"]')]
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0], 60000, "ô prompt Flow");
  await inputLikeUser(editor, task.prompt);
  const submit = await waitFor(() => findSubmit(editor), 20000, "nút mũi tên Tạo (Flow chưa ghi nhận prompt)");
  // Let lazy-loaded historical cards settle before taking the baseline. A
  // card is accepted only when both its href and image source are new.
  const before = recoverExistingImage ? { hrefs: new Set(), sources: new Set() } :
    task.type === "image" ? await stableImageBaseline() : {
    hrefs: new Set([...document.querySelectorAll('a[href]')].map(el => el.href)),
    sources: new Set()
  };
  // A previous attempt may have successfully created the image and then lost
  // the gallery/viewer transition. On retry, do not spend another generation:
  // inspect existing cards and accept only a viewer whose full prompt matches.
  if (!recoverExistingImage) await clickLikeUser(submit);
  // Flow gallery cards do not contain their prompt. Collect only stable, new
  // asset IDs here; image prompts are verified after opening each viewer.
  const discovered = new Map();
  const generationStartedAt = Date.now() - (recoverExistingImage ? 55000 : 0);
  let lastDiscoveryAt = Date.now();
  const result = await waitFor(() => {
    const flowError = visibleFlowError();
    if (flowError) throw new Error(`Google Flow: ${flowError}`);
    const now = Date.now();
    const candidates = task.type === "video" ? generatedVideoLinks() : generatedLinks();
    for (const link of candidates) {
      const source = link.querySelector("img")?.currentSrc || link.querySelector("img")?.src || "";
      if (!visible(link) || before.hrefs.has(link.href) || (task.type === "image" && before.sources.has(source)) || discovered.has(link.href)) continue;
      discovered.set(link.href, { link, source, discoveredAt: now });
      lastDiscoveryAt = now;
    }
    const waitedLongEnough = now - generationStartedAt >= 55000;
    const galleryIsQuiet = now - lastDiscoveryAt >= 8000;
    if (discovered.size < expectedOutputs || !waitedLongEnough || !galleryIsQuiet) return null;
    // Keep a small candidate pool. Viewer prompt verification below rejects
    // lazy-mounted historical cards without ever returning their media.
    return [...discovered.values()].slice(0, Math.max(expectedOutputs, 12)).map(value => value.link.href);
  }, Number(task.timeoutMs || (task.type === "video" ? 600000 : 180000)),
  task.type === "video"
    ? "video kết quả mới"
    : "ảnh kết quả mới");
  const resultUrls = result;
  if (task.type === "video") {
    const firstResult = [...document.querySelectorAll('a[href]')].find(link => link.href === resultUrls[0]);
    if (!firstResult) throw new Error("Thẻ kết quả mới đã biến mất khỏi thư viện Flow");
    await clickLikeUser(clickableResult(firstResult));
    await sleep(1000);
    const outputVideo = await waitFor(() => [...document.querySelectorAll("video")]
      .filter(el => visible(el) && (el.currentSrc || el.src))
      .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))[0], 60000, "video lớn để tải");
    // Starting the media URL from a chrome-extension:// origin causes Google
    // Flow's credentialed redirect to be blocked by CORS. Click the real Flow
    // Download button in page context, exactly like the verified manual flow.
    const downloadButton = await waitFor(
      () => buttonWithLabel(/(?:Tải xuống|Download)/i),
      30000,
      "nút Tải xuống video"
    );
    await clickLikeUser(downloadButton);
    const uploaded = await uploadFlowVideo(task, outputVideo.currentSrc || outputVideo.src);
    return { ok: true, downloaded: true,
      videoUrl: uploaded.mediaUrl, objectKey: uploaded.objectKey };
  }
  const downloads = [];
  let rejectedPromptMismatch = 0;
  for (let candidateIndex = 0; candidateIndex < resultUrls.length && downloads.length < expectedOutputs; candidateIndex += 1) {
    // Never navigate the gallery tab to /edit/<asset>: Flow can perform a full
    // navigation there, which destroys this content-script message channel.
    // The service worker opens a short-lived viewer tab and closes it after
    // prompt verification/download, leaving generation state untouched.
    const inspected = await chrome.runtime.sendMessage({
      type: "INSPECT_IMAGE_URL",
      url: resultUrls[candidateIndex],
      prompt: task.prompt,
      jobId: task.jobId,
      index: task.index,
      output: downloads.length + 1
    });
    if (!inspected?.ok) throw new Error(inspected?.error || `Không kiểm tra được ảnh ứng viên ${candidateIndex + 1}`);
    if (!inspected.matched) {
      rejectedPromptMismatch += 1;
      // This is an expected correlation check, not an extension error. Keep it
      // as a single readable info line so Chrome does not surface [object Object]
      // as a scary item in the extension Errors page.
      console.info(`[Flow Worker] bỏ qua ảnh không khớp prompt; job=${task.jobId}; item=${task.index}; candidate=${candidateIndex + 1}; url=${resultUrls[candidateIndex]}`);
      continue;
    }
    downloads.push(inspected.download);
    console.info("[Flow Worker] selected correlated image result", {
      jobId: task.jobId,
      index: task.index,
      output: downloads.length,
      candidatesSeen: discovered.size,
      rejectedPromptMismatch
    });
  }
  if (downloads.length < expectedOutputs) {
    throw new Error(`Chỉ xác minh được ${downloads.length}/${expectedOutputs} ảnh đúng prompt; đã loại ${rejectedPromptMismatch} ảnh không khớp`);
  }
  return {
    ok: true,
    downloaded: true,
    filename: downloads[0]?.filename || null,
    imageUrl: downloads[0]?.imageUrl || null,
    objectKey: downloads[0]?.objectKey || null,
    filenames: downloads.map(item => item.filename).filter(Boolean),
    imageUrls: downloads.map(item => item.imageUrl).filter(Boolean),
    objectKeys: downloads.map(item => item.objectKey).filter(Boolean)
  };
}

async function inspectImageCandidate(message) {
  const promptMatched = await waitFor(
    () => viewerMatchesPrompt(message.prompt),
    15000,
    "prompt trong viewer ảnh"
  ).then(() => true).catch(() => false);
  if (!promptMatched) return { ok: true, matched: false };
  const outputImage = await waitFor(() => imageViewerCandidate(), 30000, "ảnh viewer đúng prompt");
  const download = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_URL",
    url: outputImage.currentSrc || outputImage.src,
    jobId: message.jobId,
    index: message.index,
    output: message.output
  });
  if (!download?.ok) throw new Error(download?.error || "Không tải được ảnh viewer");
  return { ok: true, matched: true, download };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PING") return sendResponse({ ok: true });
  if (message.type === "INSPECT_IMAGE_CANDIDATE") {
    inspectImageCandidate(message).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "GENERATE") {
    generate(message.task).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
