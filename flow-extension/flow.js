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

async function uploadFlowReferenceFile(uploadButton, dataUrl, filename, timeout = 30000) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let armed = false;
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Flow không nhận ảnh tham chiếu sau 30 giây"));
    }, timeout);
    async function receive(event) {
      if (event.source !== window || event.data?.id !== id) return;
      if (event.data.type === "FLOW_UPLOAD_FILE_ARMED") {
        if (!event.data.ok) {
          clearTimeout(timer);
          window.removeEventListener("message", receive);
          reject(new Error(event.data.error || "Không chuẩn bị được ảnh tham chiếu"));
          return;
        }
        if (armed) return;
        armed = true;
        try {
          await clickLikeUser(uploadButton);
        } catch (error) {
          clearTimeout(timer);
          window.removeEventListener("message", receive);
          reject(error);
        }
        return;
      }
      if (event.data.type !== "FLOW_UPLOAD_FILE_RESULT") return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (event.data.ok) resolve(true);
      else reject(new Error(event.data.error || "Flow không nhận file ảnh tham chiếu"));
    }
    window.addEventListener("message", receive);
    window.postMessage({ type: "FLOW_ARM_FILE_UPLOAD", id, dataUrl, filename }, "*");
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

function videoStartFrameControl() {
  return deepElements('button,[role="button"],label,div,span,p')
    .filter(el => {
      if (!visible(el) || !/^(?:Bắt đầu|Start)$/i.test(labelText(el))) return false;
      const rect = el.getBoundingClientRect();
      // The start-frame slot belongs to the bottom composer. Exclude sidebar
      // labels and historical media cards that can contain the same wording.
      return rect.top > window.innerHeight * 0.5 && rect.width <= 300 && rect.height <= 140;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.top - ar.top || (ar.width * ar.height) - (br.width * br.height);
    })[0] || null;
}

async function attachReference(dataUrl, type = "image") {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const extension = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
  const filename = `reference-${Date.now()}.${extension}`;

  const addButton = await waitFor(
    () => type === "video"
      ? videoStartFrameControl()
      : buttonWithLabel(/^(?:add(?:_2)?\s*)?(?:Tạo|Add media|Thêm nội dung nghe nhìn)$/i),
    60000,
    type === "video" ? "ô Bắt đầu của khung hình video" : "nút + cạnh ô prompt"
  ).catch(() => null);
  if (!addButton) {
    const visibleButtons = deepElements('button,[role="button"]')
      .filter(visible)
      .slice(0, 20)
      .map(el => `${el.getAttribute("aria-label") || ""} ${text(el)}`.trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Không tìm thấy ${type === "video" ? "ô Bắt đầu" : "nút + cạnh ô prompt"} tại ${location.href}. Các nút: ${visibleButtons || "(không có)"}`);
  }
  await clickLikeUser(addButton);
  await sleep(500);

  const initialDialog = await waitFor(referenceDialog, 10000, "hộp chọn ảnh tham chiếu");
  const previewFingerprint = modal => {
    if (!modal) return "";
    return [...modal.querySelectorAll("img")]
      .filter(el => {
        if (!visible(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 220 && rect.height >= 120;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })
      .map(el => el.currentSrc || el.src || "")
      .filter(Boolean)
      .join("|");
  };
  const previewBeforeUpload = previewFingerprint(initialDialog);
  const imageSourcesBeforeUpload = new Set(
    initialDialog
      ? [...initialDialog.querySelectorAll("img")].map(el => el.currentSrc || el.src || "").filter(Boolean)
      : []
  );

  const uploadButton = await waitFor(() => buttonWithLabel(/(?:Tải nội dung nghe nhìn lên|Upload media)/i), 10000, "nút tải ảnh lên");
  // Arm the MAIN-world picker interceptor before clicking. This supplies the
  // File to Flow without ever opening the native macOS chooser.
  await uploadFlowReferenceFile(uploadButton, dataUrl, filename);

  // Flow shows this consent only on the first upload for a Google account.
  const consent = await waitFor(() => buttonWithLabel(/^(?:Tôi đồng ý|I agree)$/i), 5000, "xác nhận upload").catch(() => null);
  if (consent) await clickLikeUser(consent);

  // New Flow builds no longer expose the local filename in the media card.
  // A successful upload normally auto-selects the new image and changes the
  // large preview. Keep filename matching for older builds, then fall back to
  // the Uploads collection and its newest thumbnail.
  const uploadState = await waitFor(() => {
    const modal = referenceDialog();
    const byFilename = modal && [...modal.querySelectorAll('[role="option"],button')]
      .find(el => visible(el) && text(el).includes(filename));
    if (byFilename) return { option: byFilename };
    const previewAfterUpload = previewFingerprint(modal);
    if (previewAfterUpload && previewAfterUpload !== previewBeforeUpload) return { selected: true };
    return null;
  }, 30000, "ảnh vừa upload trong thư viện").catch(() => null);

  if (uploadState?.option) {
    await clickLikeUser(uploadState.option);
    await sleep(750);
    // In the current Flow frame picker, clicking a media option can attach it
    // immediately and close the dialog. There is then no Add-to-prompt button.
    if (!referenceDialog()) return;
  } else if (!uploadState?.selected) {
    const uploadsTab = await waitFor(
      () => {
        const modal = referenceDialog();
        if (!modal) return null;
        return deepElements('button,[role="button"],[role="tab"]', modal).find(el => {
          if (!visible(el)) return false;
          const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${text(el)}`;
          return /(?:Tệp tải lên|Uploads?)/i.test(label);
        }) || null;
      },
      10000,
      "mục Tệp tải lên"
    ).catch(() => null);
    if (uploadsTab) {
      await clickLikeUser(uploadsTab);
      await sleep(700);
    }

    const newestUpload = await waitFor(() => {
      const modal = referenceDialog();
      if (!modal) return null;
      const modalRect = modal.getBoundingClientRect();
      const candidates = [...modal.querySelectorAll("img")]
        .filter(el => {
          if (!visible(el)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width >= 32 && rect.height >= 32 && rect.width <= 200 &&
            rect.left < modalRect.left + modalRect.width * 0.55;
        })
        .sort((a, b) => {
          const aNew = imageSourcesBeforeUpload.has(a.currentSrc || a.src || "") ? 0 : 1;
          const bNew = imageSourcesBeforeUpload.has(b.currentSrc || b.src || "") ? 0 : 1;
          if (aNew !== bNew) return bNew - aNew;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.top - br.top || ar.left - br.left;
        });
      return candidates[0] ? clickableResult(candidates[0]) : null;
    }, 30000, "thumbnail mới nhất trong Tệp tải lên");
    await clickLikeUser(newestUpload);
    await sleep(750);
    if (!referenceDialog()) return;
  }

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
  const target = await waitFor(() => {
    const section = deepElements('a,button,[role="button"],[role="tab"],[role="link"]')
      .filter(element => {
        if (!visible(element) || !pattern.test(labelText(element))) return false;
        const rect = element.getBoundingClientRect();
        // The mode switch requested here is the project sidebar, not a Video
        // option inside the settings popover or a generated media card.
        return rect.left < Math.min(360, window.innerWidth * 0.3) && rect.top > 80 && rect.height < 100;
      })
      .sort((a, b) => labelText(a).length - labelText(b).length)[0] || null;
    if (section) return { section };

    // The September 2026 Flow project UI removed the Images/Video library
    // tabs from the sidebar. A fresh project instead starts with the generic
    // Agent composer and the media type is selected from its bottom button.
    // `configure` handles that picker, so do not block for a sidebar item
    // which cannot exist in this UI variant.
    const readyComposer = deepElements('button,[role="button"]')
      .find(element => {
        if (!visible(element)) return false;
        const label = labelText(element).trim();
        const genericAgent = /^(?:Tác nhân|Agent)$/i.test(label);
        const configuredMedia = /(?:crop_[\d_]+|\d+\s*:\s*\d+)/i.test(label) && /x\d/i.test(label);
        if (!genericAgent && !configuredMedia) return false;
        const rect = element.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.6 && rect.width < 400 && rect.height < 100;
      });
    // A configured Nano Banana/Veo composer is also sufficient. Flow can
    // collapse or delay the media-library sidebar while keeping this composer
    // fully usable; waiting for the sidebar in that state caused intermittent
    // 60-second failures before `configure` ever got a chance to run.
    return readyComposer ? { skip: true } : null;
  }, 60000, `mục ${type === "video" ? "Video" : "Hình ảnh"} ở sidebar Flow`);

  if (target.skip) return;
  await clickLikeUser(target.section);
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
  const findModeButton = () => {
    const buttons = deepElements("button").filter(el => {
      const label = labelText(el);
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.top <= window.innerHeight * 0.6 || rect.width >= 400 || rect.height >= 100) return false;

      // Older Flow builds display model + ratio + output count here. The
      // current UI can instead start a project in the generic `Tác nhân`
      // (Agent) composer, which only renders that short label. Clicking this
      // same bottom-composer button opens the media-type picker, so accept it
      // as a mode button and let the branch below switch it to Image/Video.
      const configured = /(?:crop_[\d_]+|\d+\s*:\s*\d+)/i.test(label) && /x\d/i.test(label);
      const genericAgent = /^(?:Tác nhân|Agent)$/i.test(label.trim());
      // Flow's current UI briefly removes the output-count text after an x1
      // selection and can replace the crop icon with the model name alone.
      // This is still the same composer control. Requiring both `crop_*` and
      // `x1` made the final mode check fail even though Image was selected.
      const namedMedia = /(?:Nano Banana|Imagen|Hình ảnh|Image|Video|Veo)/i.test(label);
      const ratioOnly = /(?:crop_[\d_]+|\d+\s*:\s*\d+)/i.test(label);
      return configured || genericAgent || namedMedia || ratioOnly;
    });
    const labelled = buttons
    // The current composer renders model and ratio as separate adjacent
    // buttons. Prefer a named model button over a ratio-only button; otherwise
    // opening `1:1` here leads to a ratio menu that cannot contain Image/Video.
    .sort((a, b) => {
      const rank = (el) => {
        const label = labelText(el).trim();
        const configured = /(?:crop_[\d_]+|\d+\s*:\s*\d+)/i.test(label) && /x\d/i.test(label);
        const namedMedia = /(?:Nano Banana|Imagen|Hình ảnh|Image|Video|Veo)/i.test(label);
        const genericAgent = /^(?:Tác nhân|Agent)$/i.test(label);
        if (configured) return 4;
        if (namedMedia) return 3;
        if (genericAgent) return 2;
        return 1;
      };
      return rank(b) - rank(a);
    })[0];
    if (labelled) return labelled;

    // Last-resort structural lookup for UI experiments where Flow renders the
    // mode button as an icon without useful text. It sits in the same bottom
    // composer as the prompt editor and opens a popup/menu. Submit and media
    // attachment controls are explicitly excluded.
    const editor = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    if (!editor) return null;
    const er = editor.getBoundingClientRect();
    return deepElements("button")
      .filter(el => {
        if (!visible(el)) return false;
        const label = labelText(el);
        if (/arrow_forward|add_2|Add media|Thêm nội dung nghe nhìn|Tạo|Create|Generate/i.test(label)) return false;
        const rect = el.getBoundingClientRect();
        const nearComposer = rect.top >= er.top - 40 && rect.top <= er.bottom + 120 &&
          rect.left >= er.left - 80 && rect.right <= er.right + 80 && rect.width < 400 && rect.height < 100;
        return nearComposer && (el.hasAttribute("aria-haspopup") || rect.left < er.left + er.width * 0.7);
      })
      .sort((a, b) => {
        const ah = a.hasAttribute("aria-haspopup") ? 1 : 0;
        const bh = b.hasAttribute("aria-haspopup") ? 1 : 0;
        if (ah !== bh) return bh - ah;
        return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
      })[0] || null;
  };
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
      // Do not require the popover to contain ratio and output controls at
      // the same time. The current Flow UI opens a first-level media picker
      // (Image/Video) and only renders ratio/x1 after that selection, so the
      // old `findModeMenu` predicate could reject a perfectly open menu.
    }
    return waitFor(findControl, 10000, label);
  }

  // Only switch media type when the composer is actually in the opposite
  // mode. Once Nano Banana is selected, Flow opens the settings submenu
  // directly (ratio/output) and no longer includes an Image item there.
  // Trying to re-select Image in that state caused a false 10-second timeout.
  if (!expectedMode.test(labelText(mode))) {
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
      if (!current) return null;
      const label = labelText(current);
      // A successful click on the exact Image/Video menu item is authoritative.
      // New Flow variants may leave the replacement button icon-only.
      const visiblyOpposite = type === "image"
        ? /Video|Veo/i.test(label)
        : /Nano Banana|Imagen|Hình ảnh|Image/i.test(label);
      return visiblyOpposite ? null : current;
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

function flowDurationSeconds() {
  const values = [...document.querySelectorAll("body *")]
    .filter(visible)
    .map(element => text(element))
    .filter(value => /^\d{2}:\d{2}:\d{2}$/.test(value))
    .map(value => {
      const [minutes, seconds, frames] = value.split(":").map(Number);
      return minutes * 60 + seconds + frames / 30;
    });
  return values.length ? Math.max(...values) : 0;
}

async function extendVideo(task) {
  if (!/\/tools\/flow\/project\/[^/]+\/scene\/[^/]+/.test(location.pathname)) {
    throw new Error(`Video nối tiếp cần URL scene Flow, hiện đang ở ${location.href}`);
  }
  const sourceDuration = await waitFor(() => {
    const duration = flowDurationSeconds();
    return duration >= 1 ? duration : null;
  }, 60000, "thời lượng video nguồn");

  const addClip = await waitFor(() => deepElements('button,[role="button"]')
    .filter(element => visible(element) && /(?:Thêm đoạn trích video|Add video clip)/i.test(labelText(element)))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    })[0] || null, 30000, "nút Thêm đoạn trích video");
  await clickLikeUser(addClip);
  await waitAndClickByText(
    /(?:Kéo dài|Extend).*Veo\s*3\.1.*(?:Lite|Nhanh)/i,
    'button,[role="button"],[role="menuitem"],[role="option"]',
    15000,
    "Kéo dài (Veo 3.1 Lite)"
  );
  await sleep(800);

  const editor = await waitFor(() => [...document.querySelectorAll('[contenteditable="true"]')]
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0], 30000, "ô prompt nối video");
  await inputLikeUser(editor, task.prompt);
  const submit = await waitFor(() => findSubmit(editor), 20000, "nút Tạo video nối (Flow chưa ghi nhận prompt)");
  await clickLikeUser(submit);

  const generationStartedAt = Date.now();
  const finalDuration = await waitFor(() => {
    const flowError = visibleFlowError();
    if (flowError) throw new Error(`Google Flow: ${flowError}`);
    const duration = flowDurationSeconds();
    const saveFrame = buttonWithLabel(/(?:Lưu khung hình|Save frame)/i);
    const promptAccepted = normalizedPrompt(document.body.innerText).includes(normalizedPrompt(task.prompt));
    // Flow immediately paints a provisional 16-second timeline. Do not accept
    // it until generation has had time to finish and the real save-frame UI is
    // back; this is the exact distinction verified manually across reloads.
    if (Date.now() - generationStartedAt < 55000 || !saveFrame || !promptAccepted || duration <= sourceDuration + 1) return null;
    return duration;
  }, Number(task.timeoutMs || 900000), "video nối tiếp hoàn tất");

  // Commit the generated continuation to the scene before the service worker
  // reloads it for persistence verification. Flow can otherwise show a
  // provisional timeline that disappears after navigation.
  const doneButton = buttonWithLabel(/^(?:Xong|Done)$/i);
  if (doneButton) {
    await clickLikeUser(doneButton);
    await sleep(1500);
  }

  return {
    ok: true,
    prepared: true,
    flowUrl: location.href,
    sourceDurationSeconds: Math.round(sourceDuration * 1000) / 1000,
    durationSeconds: Math.round(finalDuration * 1000) / 1000
  };
}

async function verifyExtendedVideo(task) {
  if (!/\/tools\/flow\/project\/[^/]+\/scene\/[^/]+/.test(location.pathname)) {
    throw new Error(`Không thể xác minh video nối sau reload; URL hiện tại: ${location.href}`);
  }
  const sourceDuration = Number(task.sourceDurationSeconds || 0);
  const expectedDuration = Number(task.expectedDurationSeconds || sourceDuration + 2);
  const persistedDuration = await waitFor(() => {
    const flowError = visibleFlowError();
    if (flowError) throw new Error(`Google Flow sau reload: ${flowError}`);
    const duration = flowDurationSeconds();
    const saveFrame = buttonWithLabel(/(?:Lưu khung hình|Save frame)/i);
    if (!saveFrame || duration <= sourceDuration + 1 || duration < expectedDuration - 1) return null;
    return duration;
  }, 90000, "video nối vẫn tồn tại sau reload");

  const outputVideo = await waitFor(() => [...document.querySelectorAll("video")]
    .filter(element => visible(element) && (element.currentSrc || element.src))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0], 60000, "video nối hoàn chỉnh để tải");
  const downloadButton = await waitFor(() => buttonWithLabel(/(?:Tải xuống|Download)/i), 30000, "nút Tải xuống video nối");
  await clickLikeUser(downloadButton);
  const uploaded = await uploadFlowVideo(task, outputVideo.currentSrc || outputVideo.src);
  return {
    ok: true,
    downloaded: true,
    videoUrl: uploaded.mediaUrl,
    objectKey: uploaded.objectKey,
    flowUrl: location.href,
    durationSeconds: Math.round(persistedDuration * 1000) / 1000
  };
}

async function generate(task) {
  if (task.type === "video" && task.mode === "extend") return extendVideo(task);
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
  if (task.referenceImageDataUrl) await attachReference(task.referenceImageDataUrl, task.type);
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
  if (message.type === "VERIFY_EXTENDED_VIDEO") {
    verifyExtendedVideo(message.task).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
