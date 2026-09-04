import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const browserRoots = [
  resolve(homedir(), "Library/Application Support/Microsoft Edge"),
  resolve(homedir(), "Library/Application Support/Google/Chrome")
];
const targets = new Set();

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

process.stdout.write(`${[...targets].join("\n")}\n`);
