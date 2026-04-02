const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWindowsArtifactRenamePlan,
  extractCodeSignAuthorities,
  getAutoUpdateSupport,
  validateManifestAssetReferences
} = require("./auto-update.cjs");

test("getAutoUpdateSupport disables mac auto-update when Developer ID signature is missing", () => {
  const output = `
Executable=/Applications/Pastyx.app/Contents/MacOS/Pastyx
Identifier=com.leeguooooo.pastyx
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=123 flags=0x2(adhoc) hashes=1+7 location=embedded
Signature=adhoc
Info.plist entries=22
TeamIdentifier=not set
`;

  const result = getAutoUpdateSupport({
    platform: "darwin",
    isDev: false,
    codeSignOutput: output
  });

  assert.equal(result.supported, false);
  assert.match(result.reason, /signed with a trusted Developer ID/i);
});

test("extractCodeSignAuthorities returns Developer ID authorities when present", () => {
  const output = `
Authority=Developer ID Application: Example Inc. (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
`;

  assert.deepEqual(extractCodeSignAuthorities(output), [
    "Developer ID Application: Example Inc. (ABCDE12345)",
    "Developer ID Certification Authority",
    "Apple Root CA"
  ]);
});

test("buildWindowsArtifactRenamePlan aligns uploaded asset names with latest.yml", () => {
  const manifest = `
version: 0.3.0
files:
  - url: Pastyx-Setup-0.3.0.exe
    sha512: abc
    size: 1
path: Pastyx-Setup-0.3.0.exe
sha512: abc
`;

  const plan = buildWindowsArtifactRenamePlan({
    manifestText: manifest,
    files: ["Pastyx.Setup.0.3.0.exe", "Pastyx.Setup.0.3.0.exe.blockmap"]
  });

  assert.deepEqual(plan, [
    { from: "Pastyx.Setup.0.3.0.exe", to: "Pastyx-Setup-0.3.0.exe" },
    { from: "Pastyx.Setup.0.3.0.exe.blockmap", to: "Pastyx-Setup-0.3.0.exe.blockmap" }
  ]);
});

test("validateManifestAssetReferences reports missing manifest assets", () => {
  const manifest = `
version: 0.3.0
files:
  - url: Pastyx-Setup-0.3.0.exe
    sha512: abc
    size: 1
path: Pastyx-Setup-0.3.0.exe
sha512: abc
`;

  const result = validateManifestAssetReferences({
    manifestText: manifest,
    files: ["Pastyx.Setup.0.3.0.exe"]
  });

  assert.deepEqual(result.missing, ["Pastyx-Setup-0.3.0.exe"]);
});
