#!/usr/bin/env node
"use strict";

// Self-heal the Electron binary before `npm run dev`.
//
// When npm is configured to block dependency install scripts (e.g. a global
// allowScripts policy), electron's postinstall never extracts its binary, and
// `electron .` then dies with the cryptic "Electron failed to install
// correctly" error. The downloaded zip is still cached, so this guard extracts
// it deterministically instead of leaving the developer to debug node_modules.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");

const log = (msg) => console.log(`[ensure-electron] ${msg}`);

const binaryFromPathFile = () => {
  try {
    const rel = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
    if (!rel) return "";
    return path.join(electronDir, "dist", rel);
  } catch {
    return "";
  }
};

const isReady = () => {
  const bin = binaryFromPathFile();
  if (!bin) return false;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const readExpectedVersion = () => {
  try {
    const v = fs.readFileSync(path.join(electronDir, "package.json"), "utf8");
    return JSON.parse(v).version;
  } catch {
    return "";
  }
};

const cachedZipFor = (version) => {
  // @electron/get stores artifacts under the platform cache dir.
  const candidates = [
    path.join(os.homedir(), "Library", "Caches", "electron"),
    path.join(os.homedir(), ".cache", "electron"),
    process.env.electron_config_cache || ""
  ].filter(Boolean);
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  for (const dir of candidates) {
    const zip = path.join(dir, name);
    if (fs.existsSync(zip)) return zip;
  }
  return "";
};

const main = () => {
  if (isReady()) {
    return;
  }

  log("electron binary missing — repairing (install scripts were likely skipped)");

  // First try the official installer; it's a no-op when already present.
  try {
    execFileSync(process.execPath, [path.join(electronDir, "install.js")], {
      stdio: "inherit"
    });
  } catch {
    // fall through to manual extraction
  }
  if (isReady()) {
    log("repaired via electron install.js");
    return;
  }

  const version = readExpectedVersion();
  const zip = version ? cachedZipFor(version) : "";
  if (!zip) {
    console.error(
      "[ensure-electron] could not find a cached electron zip; run `node node_modules/electron/install.js` with network access, then retry."
    );
    process.exit(1);
  }

  const distDir = path.join(electronDir, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  log(`extracting ${path.basename(zip)}`);
  execFileSync("unzip", ["-q", "-o", zip, "-d", distDir], { stdio: "inherit" });
  fs.writeFileSync(
    path.join(electronDir, "path.txt"),
    "Electron.app/Contents/MacOS/Electron"
  );

  if (!isReady()) {
    console.error("[ensure-electron] extraction completed but the binary is still missing");
    process.exit(1);
  }
  log(`repaired electron v${version} from cache`);
};

main();
