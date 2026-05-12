const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { shouldApplyAdHocMacSignature } = require("./auto-update.cjs");

// electron-builder hook:
// - On macOS, unsigned local/CI builds can be left in a partially signed state when
//   distribution signing is unavailable.
// - That can trip Gatekeeper with: "code has no resources but signature indicates they must be present".
// - We fix only those unsigned builds by ad-hoc signing the final .app bundle.
// - Developer ID signed release builds must be left intact, or electron-updater will reject them.
exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const appOutDir = context.appOutDir;
  const expectedName = `${context.packager.appInfo.productFilename}.app`;
  let appPath = path.join(appOutDir, expectedName);

  if (!fs.existsSync(appPath)) {
    const entries = fs.readdirSync(appOutDir);
    const found = entries.find((e) => e.endsWith(".app"));
    if (!found) {
      throw new Error(`afterPack: no .app found in ${appOutDir}`);
    }
    appPath = path.join(appOutDir, found);
  }

  const result = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8"
  });
  const codeSignOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (!shouldApplyAdHocMacSignature({ platform: process.platform, codeSignOutput })) {
    return;
  }

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit"
  });

  execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], {
    stdio: "inherit"
  });
};
