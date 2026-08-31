#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const optionIndexes = new Set(args.flatMap((x, i) => x.startsWith("--") ? [i, i + 1] : []));
const directPrompt = args.find((_, i) => !optionIndexes.has(i));
const projectUrl = option("--url", process.env.FLOW_PROJECT_URL || "https://labs.google/fx/vi/tools/flow");
const promptFile = option("--file", "prompts.txt");
const ratio = option("--ratio", "16:9");
const delayMs = Number(option("--delay", "15000"));
const timeoutMs = Number(option("--timeout", "180000"));
const profileDir = path.resolve(option("--profile", ".flow-chrome-profile"));
const outputDir = path.resolve(option("--output", "flow-images"));

if (!new Set(["16:9", "4:3", "1:1", "3:4", "9:16"]).has(ratio)) throw new Error(`Tỷ lệ không hợp lệ: ${ratio}`);
let prompts;
if (directPrompt) prompts = [directPrompt];
else prompts = (await fs.readFile(promptFile, "utf8")).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
if (!prompts.length) throw new Error("Không có prompt để tạo.");
await fs.mkdir(outputDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome", headless: false, acceptDownloads: true, viewport: null,
  args: ["--start-maximized"]
});
const page = context.pages()[0] || await context.newPage();
const slug = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "image";

async function pressTextLikeUser(locator, text) {
  // Flow dùng Slate: fill()/type() có thể chỉ đổi DOM nhưng không cập nhật state.
  await locator.click();
  for (const ch of text) {
    if (ch === "\n") await locator.press("Shift+Enter");
    else if (ch === " ") await locator.press("Space");
    else if (/^[\x21-\x7e]$/.test(ch)) await locator.press(ch);
    else await page.keyboard.insertText(ch);
  }
}

async function setImageMode() {
  await page.getByRole("button", { name: /(?:Video|Nano Banana).*x\d/ }).click();
  await page.getByRole("tab", { name: /Hình ảnh|Image/ }).click();
  await page.getByRole("tab", { name: new RegExp(ratio.replace(":", "\\:")) }).click();
  await page.keyboard.press("Escape");
}

async function generate(prompt, index) {
  const resultLinks = page.getByRole("link", { name: /Hình ảnh được tạo|Generated image/ });
  const before = await resultLinks.count();
  const editor = page.locator('[contenteditable="true"]').last();
  await pressTextLikeUser(editor, prompt);
  const submit = page.getByRole("button", { name: /arrow_forward (?:Tạo|Create)/ });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find(x => /arrow_forward/.test(x.innerText) && /(Tạo|Create)/.test(x.innerText));
    return b?.getAttribute("aria-disabled") !== "true";
  }, null, { timeout: 15000 });
  await submit.click();

  const result = resultLinks.nth(before);
  await result.waitFor({ state: "visible", timeout: timeoutMs });
  await result.click();
  const downloadButton = page.getByRole("button", { name: /Tải xuống|Download/ });
  await downloadButton.waitFor({ state: "visible", timeout: 30000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await downloadButton.click();
  const download = await downloadPromise;
  const ext = path.extname(download.suggestedFilename()) || ".png";
  const file = path.join(outputDir, `${String(index + 1).padStart(3, "0")}-${slug(prompt)}${ext}`);
  await download.saveAs(file);
  console.log(`[${index + 1}/${prompts.length}] Đã lưu: ${file}`);
  const back = page.getByRole("button", { name: /Quay lại|Back/ });
  if (await back.isVisible()) await back.click();
}

try {
  await page.goto(projectUrl, { waitUntil: "domcontentloaded" });
  console.log("Nếu được hỏi, đăng nhập Google một lần trong cửa sổ Chrome này.");
  await page.locator('[contenteditable="true"]').last().waitFor({ state: "visible", timeout: 120000 });
  const understood = page.getByRole("button", { name: /Tôi hiểu|Got it/ });
  if (await understood.isVisible().catch(() => false)) await understood.click();
  await setImageMode();
  for (let i = 0; i < prompts.length; i++) {
    await generate(prompts[i], i);
    if (i + 1 < prompts.length) await page.waitForTimeout(delayMs);
  }
  console.log("Hoàn tất.");
} catch (error) {
  console.error(`Thất bại: ${error.message}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
