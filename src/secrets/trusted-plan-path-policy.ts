const WINDOWS_TRUSTED_INSTALLER_SID =
  "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const WINDOWS_SAFE_DIRECTORY_ACL_TOKENS = new Set(
  "AD CI GE GR I IO NP OI R RA RC RD REA RX S WD X".split(" "),
);
const WINDOWS_SAFE_EXECUTABLE_PARENT_ACL_TOKENS = new Set(
  [...WINDOWS_SAFE_DIRECTORY_ACL_TOKENS].filter((token) => token !== "AD" && token !== "WD"),
);

function isTrustedOwner(
  stat: { uid?: number | null },
  permissions: { ownerTrusted?: boolean; ownerSid?: string },
  platform: NodeJS.Platform = process.platform,
  allowWindowsTrustedInstaller = false,
): boolean {
  if (platform === "win32") {
    return (
      permissions.ownerTrusted === true ||
      (allowWindowsTrustedInstaller &&
        permissions.ownerSid?.toLowerCase() === WINDOWS_TRUSTED_INSTALLER_SID)
    );
  }
  if (typeof process.getuid !== "function" || stat.uid == null) {
    return false;
  }
  const uid = process.getuid();
  return stat.uid === uid || stat.uid === 0;
}

function isSafeWindowsDirectoryAclEntry(
  entry: { rawRights: string } | null,
  allowChildCreation = true,
): boolean {
  if (!entry || typeof entry.rawRights !== "string") {
    return false;
  }
  const tokens = [...entry.rawRights.matchAll(/\(([^)]+)\)/gu)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean),
  );
  // Inherit-only entries do not grant rights on the directory itself. Descendants are
  // inspected independently with their effective ACL and owner.
  const safeTokens = allowChildCreation
    ? WINDOWS_SAFE_DIRECTORY_ACL_TOKENS
    : WINDOWS_SAFE_EXECUTABLE_PARENT_ACL_TOKENS;
  return (
    tokens.includes("IO") || (tokens.length > 0 && tokens.every((token) => safeTokens.has(token)))
  );
}

function isSafeWindowsDirectoryAclEntries(
  entries: Array<{ rawRights: string }>,
  allowChildCreation = true,
): boolean {
  return entries.every((entry) => isSafeWindowsDirectoryAclEntry(entry, allowChildCreation));
}

function isSafeWindowsDirectoryAclSummary(
  summary: string | undefined,
  allowChildCreation = true,
): boolean {
  if (summary === "trusted-only") {
    return true;
  }
  if (!summary) {
    return false;
  }
  const entries = summary.split(", ").map((value) => {
    const separatorIndex = value.lastIndexOf(":");
    const rawRights = separatorIndex > 0 ? value.slice(separatorIndex + 1) : "";
    return /^(?:\([^)]+\))+$/u.test(rawRights) ? { rawRights } : null;
  });
  return (
    entries.length > 0 &&
    entries.every((entry) => entry !== null) &&
    isSafeWindowsDirectoryAclEntries(entries, allowChildCreation)
  );
}

export const trustedPlanPathPolicy = {
  isSafeWindowsDirectoryAclEntries,
  isSafeWindowsDirectoryAclSummary,
  isTrustedOwner,
};
