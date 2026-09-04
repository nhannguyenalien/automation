import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = process.env.FLOW_WORKER_REPO_DIR
  ? resolve(process.env.FLOW_WORKER_REPO_DIR)
  : resolve(scriptDir, "..");
const host = "127.0.0.1";
const port = Number(process.env.FLOW_WORKER_UPDATE_PORT || 8765);
let lastStatus = { ok: true, updated: false, error: "", checkedAt: null };

async function currentVersion() {
  const manifest = JSON.parse(await readFile(resolve(repoDir, "flow-extension/manifest.json"), "utf8"));
  return manifest.version;
}

async function syncLoadedExtensions() {
  const source = resolve(repoDir, "flow-extension");
  const browserRoots = [
    resolve(homedir(), "Library/Application Support/Microsoft Edge"),
    resolve(homedir(), "Library/Application Support/Google/Chrome")
  ];
  const targets = new Set(
    (process.env.FLOW_WORKER_EXTENSION_DIRS || "").split(";").filter(Boolean).map(value => resolve(value))
  );

  for (const browserRoot of browserRoots) {
    let profiles = [];
    try { profiles = await readdir(browserRoot, { withFileTypes: true }); } catch { continue; }
    for (const profile of profiles.filter(entry => entry.isDirectory())) {
      try {
        const preferences = JSON.parse(await readFile(resolve(browserRoot, profile.name, "Secure Preferences"), "utf8"));
        for (const extension of Object.values(preferences.extensions?.settings || {})) {
          try {
            if (!extension.path) continue;
            const target = resolve(extension.path);
            const manifest = JSON.parse(await readFile(resolve(target, "manifest.json"), "utf8"));
            if (manifest.name === "Google AI Browser Worker") targets.add(target);
          } catch {}
        }
      } catch {}
    }
  }

  const synced = [];
  for (const target of targets) {
    if (target === source) continue;
    let runtimeConfig = null;
    try { runtimeConfig = await readFile(resolve(target, "runtime-config.js"), "utf8"); } catch {}
    await cp(source, target, { recursive: true, force: true });
    if (runtimeConfig !== null) await writeFile(resolve(target, "runtime-config.js"), runtimeConfig);
    synced.push(target);
  }
  return synced;
}

async function update() {
  const before = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
  await execFileAsync("git", ["pull", "--ff-only", "origin", "main"], { cwd: repoDir });
  const sha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
  const syncedExtensions = await syncLoadedExtensions();
  lastStatus = {
    ok: true,
    version: await currentVersion(),
    sha,
    updated: sha !== before,
    syncedExtensions,
    error: "",
    checkedAt: new Date().toISOString()
  };
  return lastStatus;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type"
  });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  if (request.method === "OPTIONS") return sendJson(response, 200, { ok: true });
  if (request.method === "GET" && request.url === "/status") {
    return sendJson(response, 200, { ...lastStatus, version: await currentVersion() });
  }
  if (request.method === "POST" && request.url === "/update") {
    try {
      return sendJson(response, 200, await update());
    } catch (error) {
      lastStatus = { ok: false, updated: false, error: error.message, checkedAt: new Date().toISOString() };
      return sendJson(response, 500, lastStatus);
    }
  }
  return sendJson(response, 404, { ok: false, error: "Not found" });
}).listen(port, host, () => {
  process.stdout.write(`Flow Worker updater listening at http://${host}:${port}\n`);
});
