import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "../infra/permissions.js";

const WINDOWS_TRUSTED_OWNER_SIDS = new Set([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // Builtin Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // TrustedInstaller
]);
const WINDOWS_TRUSTED_ACCESS_SIDS = new Set([
  ...WINDOWS_TRUSTED_OWNER_SIDS,
  "S-1-3-0", // Creator Owner resolves to the trusted creator on inherited ACEs.
]);
const WINDOWS_KNOWN_FILE_RIGHTS_MASK = 0xf21f01ff;
const WINDOWS_SYNCHRONIZE_RIGHT = 0x00100000;
const WINDOWS_STAGING_REPLACEMENT_RIGHTS_MASK = 0x120d0040;

type SupportedOwnerAndDaclResult = Extract<OwnerAndDaclResult, { status: "supported" }>;

function normalizeWindowsSid(value: string): string {
  return value.toUpperCase();
}

export function assertTrustedWindowsAcl(
  pathname: string,
  requirePrivate: boolean,
  currentUserSid: string,
  security: SupportedOwnerAndDaclResult,
): void {
  const ownerSid = normalizeWindowsSid(security.ownerSid);
  if (ownerSid !== currentUserSid && !WINDOWS_TRUSTED_OWNER_SIDS.has(ownerSid)) {
    throw new Error(`Windows staging path is owned by an untrusted principal: ${pathname}`);
  }
  const allowedEntries = security.aces.filter((entry) => entry.aceType === "allow");
  if (allowedEntries.length === 0) {
    throw new Error(`Unable to verify private Windows ACL for SQLite staging: ${pathname}`);
  }
  const unsafeEntries = allowedEntries
    .filter(
      (entry) =>
        normalizeWindowsSid(entry.sid) !== currentUserSid &&
        !WINDOWS_TRUSTED_ACCESS_SIDS.has(normalizeWindowsSid(entry.sid)),
    )
    .filter((entry) => windowsAclEntryPermitsUnsafeStagingAccess(entry, requirePrivate));
  if (unsafeEntries.length > 0) {
    throw new Error(`Windows ACL permits untrusted SQLite staging access: ${pathname}`);
  }
}

function windowsAclEntryPermitsUnsafeStagingAccess(
  entry: WindowsAccessControlEntry,
  requirePrivate: boolean,
): boolean {
  // Inherit-only ACEs on ordinary ancestors are covered when the protected
  // root is inspected. Private roots must also reject rights inherited by files.
  if (!requirePrivate && entry.flags.inheritOnly) {
    return false;
  }
  if (requirePrivate) {
    return (entry.mask & ~WINDOWS_SYNCHRONIZE_RIGHT) >>> 0 !== 0;
  }
  return (
    (entry.mask & WINDOWS_STAGING_REPLACEMENT_RIGHTS_MASK) !== 0 ||
    (entry.mask & ~WINDOWS_KNOWN_FILE_RIGHTS_MASK) >>> 0 !== 0
  );
}
