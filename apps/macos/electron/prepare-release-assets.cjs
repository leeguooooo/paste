const fs = require("node:fs");
const path = require("node:path");
const {
  buildWindowsArtifactRenamePlan,
  validateManifestAssetReferences
} = require("./auto-update.cjs");

const distDir = path.resolve(process.argv[2] || "");
if (!distDir || !fs.existsSync(distDir)) {
  console.error(`dist directory not found: ${distDir || "(empty)"}`);
  process.exit(1);
}

const listFiles = () =>
  fs.readdirSync(distDir).filter((name) => fs.statSync(path.join(distDir, name)).isFile());

const manifestFiles = listFiles().filter((name) => /^latest.*\.yml$/i.test(name)).sort();
for (const manifestName of manifestFiles) {
  const manifestPath = path.join(distDir, manifestName);
  const manifestText = fs.readFileSync(manifestPath, "utf8");

  for (const rename of buildWindowsArtifactRenamePlan({ manifestText, files: listFiles() })) {
    fs.renameSync(path.join(distDir, rename.from), path.join(distDir, rename.to));
  }

  const validation = validateManifestAssetReferences({
    manifestText,
    files: listFiles()
  });
  if (validation.missing.length > 0) {
    console.error(`manifest ${manifestName} references missing assets: ${validation.missing.join(", ")}`);
    process.exit(1);
  }
}
