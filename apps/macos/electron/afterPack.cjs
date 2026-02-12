const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// electron-builder hook:
// - On macOS, electron-builder may leave the bundle in a partially signed state when
//   distribution signing is disabled.
// - That can trip Gatekeeper with: "code has no resources but signature indicates they must be present".
// - We fix it by ad-hoc signing the final .app bundle so _CodeSignature/CodeResources exists.
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

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit"
  });

  execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], {
    stdio: "inherit"
  });
};
