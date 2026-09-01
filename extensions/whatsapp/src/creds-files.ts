// Whatsapp plugin module implements creds files behavior.
import path from "node:path";
import type { SignalDataTypeMap } from "baileys";
import {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  readRegularFile,
  readRegularFileSync,
  statRegularFile,
  statRegularFileSync,
} from "openclaw/plugin-sdk/file-access-runtime";

// The legacy OAuth root is shared; keep its exact WhatsApp namespaces aligned
// with Baileys without importing the provider into setup discovery.
const BAILEYS_SIGNAL_AUTH_CATEGORIES = {
  "app-state-sync-key": true,
  "app-state-sync-version": true,
  "device-list": true,
  "identity-key": true,
  "lid-mapping": true,
  "pre-key": true,
  "sender-key": true,
  "sender-key-memory": true,
  session: true,
  tctoken: true,
} satisfies Record<keyof SignalDataTypeMap, true>;

export function isWhatsAppBaileysAuthFileName(name: string): boolean {
  if (name === "creds.json" || name === "creds.json.bak") {
    return true;
  }
  return (
    name.endsWith(".json") &&
    Object.keys(BAILEYS_SIGNAL_AUTH_CATEGORIES).some((category) => name.startsWith(`${category}-`))
  );
}

export function resolveWebCredsPath(authDir: string): string {
  return path.join(authDir, "creds.json");
}

export function resolveWebCredsBackupPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak");
}

function resolveWebCredsParentCheck(filePath: string) {
  const dir = path.resolve(path.dirname(filePath));
  return {
    rootDir: path.parse(dir).root,
    targetPath: dir,
    allowMissing: true,
    allowRootChildSymlink: true,
    requireDirectories: true,
    messagePrefix: "WhatsApp credential file path",
  } as const;
}

async function assertWebCredsParentPathSafe(filePath: string): Promise<void> {
  await assertNoSymlinkParents(resolveWebCredsParentCheck(filePath));
}

function assertWebCredsParentPathSafeSync(filePath: string): void {
  assertNoSymlinkParentsSync(resolveWebCredsParentCheck(filePath));
}

export async function assertWebCredsPathRegularFileOrMissing(filePath: string): Promise<void> {
  try {
    await assertWebCredsParentPathSafe(filePath);
    await statRegularFile(filePath);
  } catch (error) {
    throw new Error(
      `WhatsApp credential file path is unsafe; creds.json must be a regular file or missing: ${filePath}`,
      { cause: error },
    );
  }
}

export function readWebCredsJsonRawSync(filePath: string): string | null {
  try {
    assertWebCredsParentPathSafeSync(filePath);
    const { buffer, stat } = readRegularFileSync({
      filePath,
    });
    return stat.size > 1 ? buffer.toString("utf-8") : null;
  } catch {
    return null;
  }
}

export async function readWebCredsJsonRaw(filePath: string): Promise<string | null> {
  try {
    await assertWebCredsParentPathSafe(filePath);
    const { buffer, stat } = await readRegularFile({
      filePath,
    });
    return stat.size > 1 ? buffer.toString("utf-8") : null;
  } catch {
    return null;
  }
}

export function statWebCredsFileSync(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    assertWebCredsParentPathSafeSync(filePath);
    const result = statRegularFileSync(filePath);
    if (result.missing || result.stat.size <= 1) {
      return null;
    }
    return {
      mtimeMs: result.stat.mtimeMs,
      size: result.stat.size,
    };
  } catch {
    return null;
  }
}

export function hasWebCredsRegularFileSync(authDir: string): boolean {
  try {
    const credsPath = resolveWebCredsPath(authDir);
    assertWebCredsParentPathSafeSync(credsPath);
    return !statRegularFileSync(credsPath).missing;
  } catch {
    return false;
  }
}

export function hasWebCredsSync(authDir: string): boolean {
  return statWebCredsFileSync(resolveWebCredsPath(authDir)) !== null;
}
