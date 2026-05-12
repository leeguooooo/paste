const path = require("node:path");

const extractCodeSignAuthorities = (output) => {
  const matches = String(output || "").match(/^Authority=(.+)$/gm) || [];
  return matches.map((line) => line.replace(/^Authority=/, "").trim()).filter(Boolean);
};

const hasTrustedMacDeveloperIdSignature = (output) =>
  extractCodeSignAuthorities(output).some((authority) => authority.startsWith("Developer ID Application:"));

const getAutoUpdateSupport = ({ platform, isDev, codeSignOutput }) => {
  if (isDev) {
    return {
      supported: false,
      reason: "Auto-update is unavailable in development builds."
    };
  }

  if (platform !== "darwin") {
    return { supported: true, reason: "" };
  }

  if (hasTrustedMacDeveloperIdSignature(codeSignOutput)) {
    return { supported: true, reason: "" };
  }

  return {
    supported: false,
    reason:
      "Auto-update is unavailable because this macOS build is not signed with a trusted Developer ID certificate. Use GitHub Releases for updates."
  };
};

const shouldApplyAdHocMacSignature = ({ platform, codeSignOutput }) => {
  if (platform !== "darwin") return false;
  return !hasTrustedMacDeveloperIdSignature(codeSignOutput);
};

const parseManifestAssetNames = (manifestText) => {
  const text = String(manifestText || "");
  const names = new Set();
  for (const match of text.matchAll(/^\s*-\s+url:\s+(.+?)\s*$/gm)) {
    names.add(match[1].trim());
  }
  const pathMatch = text.match(/^path:\s+(.+?)\s*$/m);
  if (pathMatch?.[1]) {
    names.add(pathMatch[1].trim());
  }
  return Array.from(names);
};

const canonicalizeAssetName = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const findMatchingAsset = (targetName, files) => {
  const targetExt = path.extname(targetName).toLowerCase();
  const targetCanonical = canonicalizeAssetName(targetName);
  const candidates = files.filter((file) => {
    const fileExt = path.extname(file.replace(/\.blockmap$/i, "")).toLowerCase();
    return fileExt === targetExt && canonicalizeAssetName(file) === targetCanonical;
  });
  return candidates.length === 1 ? candidates[0] : "";
};

const buildWindowsArtifactRenamePlan = ({ manifestText, files }) => {
  const currentFiles = Array.isArray(files) ? files.slice() : [];
  const plan = [];
  const primaryAsset = parseManifestAssetNames(manifestText).find((name) => /\.exe$/i.test(name));
  if (!primaryAsset || currentFiles.includes(primaryAsset)) {
    return plan;
  }

  const matchedExe = findMatchingAsset(primaryAsset, currentFiles);
  if (!matchedExe) {
    return plan;
  }
  plan.push({ from: matchedExe, to: primaryAsset });

  const matchedBlockmap = `${matchedExe}.blockmap`;
  const desiredBlockmap = `${primaryAsset}.blockmap`;
  if (currentFiles.includes(matchedBlockmap) && !currentFiles.includes(desiredBlockmap)) {
    plan.push({ from: matchedBlockmap, to: desiredBlockmap });
  }

  return plan;
};

const validateManifestAssetReferences = ({ manifestText, files }) => {
  const existing = new Set(Array.isArray(files) ? files : []);
  const missing = parseManifestAssetNames(manifestText).filter((name) => !existing.has(name));
  return { missing };
};

const normalizeUpdateError = (errorLike) => {
  const raw =
    errorLike instanceof Error
      ? String(errorLike.message || "auto update error")
      : String(errorLike || "auto update error");
  const isSignatureValidationError =
    /code signature/i.test(raw) && /did not pass validation/i.test(raw);
  if (!isSignatureValidationError) {
    return {
      raw,
      userMessage: raw,
      isSignatureValidationError: false
    };
  }
  return {
    raw,
    userMessage:
      "Auto-update failed signature validation. This release build is not signed with a trusted Developer ID certificate. Please update from GitHub Releases for now.",
    isSignatureValidationError: true
  };
};

module.exports = {
  buildWindowsArtifactRenamePlan,
  extractCodeSignAuthorities,
  getAutoUpdateSupport,
  hasTrustedMacDeveloperIdSignature,
  normalizeUpdateError,
  parseManifestAssetNames,
  shouldApplyAdHocMacSignature,
  validateManifestAssetReferences
};
