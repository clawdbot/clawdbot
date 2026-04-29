import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { info, success } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveOAuthDir } from "./auth-store.runtime.js";
import { hasWebCredsSync, resolveWebCredsBackupPath, resolveWebCredsPath } from "./creds-files.js";
import {
  waitForCredsSaveQueueWithTimeout,
  type CredsQueueWaitResult,
} from "./creds-persistence.js";
import { resolveComparableIdentity, type WhatsAppSelfIdentity } from "./identity.js";
import { resolveUserPath, type WebChannel } from "./text-runtime.js";
export { hasWebCredsSync, resolveWebCredsBackupPath, resolveWebCredsPath };

export const WHATSAPP_AUTH_UNSTABLE_CODE = "whatsapp-auth-unstable";

const authStoreLogger = getChildLogger({ module: "web-auth-store" });
const emptyWebSelfId = () => ({ e164: null, jid: null, lid: null }) as const;
export type WhatsAppWebAuthState = "linked" | "not-linked" | "unstable";

export class WhatsAppAuthUnstableError extends Error {
  readonly code = WHATSAPP_AUTH_UNSTABLE_CODE;

  constructor(message = "WhatsApp auth state is still stabilizing; retry shortly.") {
    super(message);
    this.name = "WhatsAppAuthUnstableError";
  }
}

export function resolveDefaultWebAuthDir(): string {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

export function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) {
      return null;
    }
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function waitForWebAuthBarrier(
  authDir: string,
  context: string,
): Promise<CredsQueueWaitResult> {
  const result = await waitForCredsSaveQueueWithTimeout(authDir);
  if (result === "timed_out") {
    authStoreLogger.warn(
      {
        authDir,
        context,
      },
      "timed out waiting for queued WhatsApp creds save before auth read",
    );
  }
  return result;
}

export async function restoreCredsFromBackupIfNeeded(authDir: string): Promise<boolean> {
  const logger = getChildLogger({ module: "web-session" });
  let tempRestorePath: string | null = null;
  try {
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      // Validate that creds.json is parseable.
      JSON.parse(raw);
      return false;
    }

    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) {
      return false;
    }
    const backupStats = await fs.lstat(backupPath).catch(() => null);
    if (!backupStats?.isFile()) {
      return false;
    }

    // Ensure backup is parseable before restoring.
    JSON.parse(backupRaw);
    tempRestorePath = path.join(authDir, `.creds.restore-${randomUUID()}.tmp`);
    await fs.writeFile(tempRestorePath, backupRaw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tempRestorePath, credsPath);
    tempRestorePath = null;
    logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
    return true;
  } catch {
    // ignore
  } finally {
    if (tempRestorePath) {
      await fs.rm(tempRestorePath, { force: true }).catch(() => {
        // best-effort temp cleanup
      });
    }
  }
  return false;
}

export async function webAuthExists(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return false;
  }
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) {
      return false;
    }
    const raw = await fs.readFile(credsPath, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function resolveWebAuthState(params: {
  linked: boolean;
  barrierResult: CredsQueueWaitResult;
}): WhatsAppWebAuthState {
  if (params.barrierResult === "timed_out") {
    return "unstable";
  }
  return params.linked ? "linked" : "not-linked";
}

async function readWebAuthStateCore(
  authDir: string,
  context: string,
): Promise<{ authDir: string; linked: boolean; state: WhatsAppWebAuthState }> {
  const resolvedAuthDir = resolveUserPath(authDir);
  const barrierResult = await waitForWebAuthBarrier(resolvedAuthDir, context);
  const linked = await webAuthExists(resolvedAuthDir);
  return {
    authDir: resolvedAuthDir,
    linked,
    state: resolveWebAuthState({ linked, barrierResult }),
  };
}

export function formatWhatsAppWebAuthStatusState(state: WhatsAppWebAuthState): string {
  switch (state) {
    case "linked":
      return "linked";
    case "not-linked":
      return "not linked";
    case "unstable":
      return "auth stabilizing";
  }
  const exhaustive: never = state;
  return exhaustive;
}

export async function readWebAuthState(
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<WhatsAppWebAuthState> {
  return (await readWebAuthStateCore(authDir, "readWebAuthState")).state;
}

export async function readWebAuthSnapshot(authDir: string = resolveDefaultWebAuthDir()) {
  const auth = await readWebAuthStateCore(authDir, "readWebAuthSnapshot");
  return {
    state: auth.state,
    authAgeMs: auth.state === "linked" ? getWebAuthAgeMs(auth.authDir) : null,
    selfId: auth.state === "linked" ? readWebSelfId(auth.authDir) : emptyWebSelfId(),
  } as const;
}

export async function readWebAuthExistsBestEffort(authDir: string = resolveDefaultWebAuthDir()) {
  const state = await readWebAuthState(authDir);
  return {
    exists: state === "linked",
    timedOut: state === "unstable",
  } as const;
}

export async function readWebAuthExistsForDecision(
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<{ outcome: "stable"; exists: boolean } | { outcome: "unstable" }> {
  const state = await readWebAuthState(authDir);
  if (state === "unstable") {
    return { outcome: "unstable" };
  }
  return {
    outcome: "stable",
    exists: state === "linked",
  };
}

export async function readWebAuthSnapshotBestEffort(authDir: string = resolveDefaultWebAuthDir()) {
  const snapshot = await readWebAuthSnapshot(authDir);
  return {
    linked: snapshot.state === "linked",
    timedOut: snapshot.state === "unstable",
    authAgeMs: snapshot.authAgeMs,
    selfId: snapshot.selfId,
  } as const;
}

function isBaileysAuthFileName(name: string): boolean {
  if (name === "oauth.json") {
    return false;
  }
  if (name === "creds.json" || name === "creds.json.bak") {
    return true;
  }
  if (!name.endsWith(".json")) {
    return false;
  }
  return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}

async function clearBaileysAuthFiles(authDir: string) {
  const rootStats = await fs.lstat(authDir).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    return;
  }
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      if (!isBaileysAuthFileName(entry.name)) {
        return;
      }
      await fs.rm(path.join(authDir, entry.name), { force: true });
    }),
  );
}

async function shouldClearOnLogout(authDir: string, isLegacyAuthDir: boolean): Promise<boolean> {
  try {
    const stats = await fs.lstat(authDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return false;
    }
    if (isLegacyAuthDir) {
      const entries = await fs.readdir(authDir, { withFileTypes: true });
      return entries.some((entry) => {
        if (!entry.isFile()) {
          return false;
        }
        return isBaileysAuthFileName(entry.name);
      });
    }
    const credsStats = await fs.lstat(resolveWebCredsPath(authDir)).catch(() => null);
    if (credsStats?.isFile()) {
      return true;
    }
    const backupStats = await fs.lstat(resolveWebCredsBackupPath(authDir)).catch(() => null);
    return backupStats?.isFile() === true;
  } catch (error) {
    const codeValue =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code = typeof codeValue === "string" ? codeValue : "";
    return code !== "ENOENT";
  }
}

function isPathInsideDirectory(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

async function pathHasSymlinkComponent(baseDir: string, targetPath: string): Promise<boolean> {
  const relativePath = path.relative(baseDir, targetPath);
  let currentPath = baseDir;
  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const stats = await fs.lstat(currentPath).catch(() => null);
    if (!stats || stats.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

type WebAuthDirOwnership =
  | { kind: "owned"; authDir: string }
  | { kind: "unsafe-owned" }
  | { kind: "external" };

async function isLegacyWebAuthDir(authDir: string): Promise<boolean> {
  const legacyAuthDir = path.resolve(resolveOAuthDir());
  const resolvedAuthDir = path.resolve(authDir);
  if (resolvedAuthDir !== legacyAuthDir) {
    return false;
  }
  const stats = await fs.lstat(resolvedAuthDir).catch(() => null);
  return stats?.isDirectory() === true && !stats.isSymbolicLink();
}

async function classifyWebAuthDirOwnership(authDir: string): Promise<WebAuthDirOwnership> {
  const whatsappAuthBase = path.resolve(resolveOAuthDir(), "whatsapp");
  const resolvedAuthDir = path.resolve(authDir);
  if (!isPathInsideDirectory(whatsappAuthBase, resolvedAuthDir)) {
    return { kind: "external" };
  }

  const [baseRealPath, authDirRealPath] = await Promise.all([
    fs.realpath(whatsappAuthBase).catch(() => null),
    fs.realpath(resolvedAuthDir).catch(() => null),
  ]);
  if (!baseRealPath || !authDirRealPath) {
    return { kind: "unsafe-owned" };
  }
  if (!isPathInsideDirectory(baseRealPath, authDirRealPath)) {
    return { kind: "unsafe-owned" };
  }
  if (await pathHasSymlinkComponent(whatsappAuthBase, resolvedAuthDir)) {
    return { kind: "unsafe-owned" };
  }
  return { kind: "owned", authDir: resolvedAuthDir };
}

export async function logoutWeb(params: {
  authDir?: string;
  isLegacyAuthDir?: boolean;
  runtime?: RuntimeEnv;
}) {
  const runtime = params.runtime ?? defaultRuntime;
  const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
  const barrierResult = await waitForWebAuthBarrier(resolvedAuthDir, "logoutWeb");
  if (barrierResult === "timed_out") {
    runtime.log(
      info("WhatsApp auth state is still stabilizing; clearing cached credentials anyway."),
    );
  }
  if (!(await shouldClearOnLogout(resolvedAuthDir, Boolean(params.isLegacyAuthDir)))) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  if (params.isLegacyAuthDir) {
    if (!(await isLegacyWebAuthDir(resolvedAuthDir))) {
      runtime.log(
        info("Skipped WhatsApp Web credential cleanup outside the managed legacy auth directory."),
      );
      return false;
    }
    await clearBaileysAuthFiles(resolvedAuthDir);
  } else {
    const ownership = await classifyWebAuthDirOwnership(resolvedAuthDir);
    if (ownership.kind === "owned") {
      await fs.rm(ownership.authDir, { recursive: true, force: true });
    } else if (ownership.kind === "unsafe-owned") {
      runtime.log(
        info(
          "Skipped WhatsApp Web credential cleanup because the auth directory crosses a symlink boundary.",
        ),
      );
      return false;
    } else {
      runtime.log(
        info("Skipped WhatsApp Web credential cleanup outside the managed auth directory."),
      );
      return false;
    }
  }
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}

export function readWebSelfId(authDir: string = resolveDefaultWebAuthDir()) {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  try {
    const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
    if (!fsSync.existsSync(credsPath)) {
      return emptyWebSelfId();
    }
    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string; lid?: string } } | undefined;
    const identity = resolveComparableIdentity(
      {
        jid: parsed?.me?.id ?? null,
        lid: parsed?.me?.lid ?? null,
      },
      authDir,
    );
    return {
      e164: identity.e164 ?? null,
      jid: identity.jid ?? null,
      lid: identity.lid ?? null,
    } as const;
  } catch {
    return emptyWebSelfId();
  }
}

export async function readWebSelfIdentity(
  authDir: string = resolveDefaultWebAuthDir(),
  fallback?: { id?: string | null; lid?: string | null } | null,
): Promise<WhatsAppSelfIdentity> {
  const resolvedAuthDir = resolveUserPath(authDir);
  try {
    const raw = await fs.readFile(resolveWebCredsPath(resolvedAuthDir), "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string; lid?: string } } | undefined;
    return resolveComparableIdentity(
      {
        jid: parsed?.me?.id ?? null,
        lid: parsed?.me?.lid ?? null,
      },
      resolvedAuthDir,
    );
  } catch {
    return resolveComparableIdentity(
      {
        jid: fallback?.id ?? null,
        lid: fallback?.lid ?? null,
      },
      resolvedAuthDir,
    );
  }
}

export async function readWebSelfIdentityForDecision(
  authDir: string = resolveDefaultWebAuthDir(),
  fallback?: { id?: string | null; lid?: string | null } | null,
): Promise<{ outcome: "stable"; identity: WhatsAppSelfIdentity } | { outcome: "unstable" }> {
  const resolvedAuthDir = resolveUserPath(authDir);
  const result = await waitForWebAuthBarrier(resolvedAuthDir, "readWebSelfIdentityForDecision");
  if (result === "timed_out") {
    return { outcome: "unstable" };
  }
  return {
    outcome: "stable",
    identity: await readWebSelfIdentity(resolvedAuthDir, fallback),
  };
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export function getWebAuthAgeMs(authDir: string = resolveDefaultWebAuthDir()): number | null {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolveUserPath(authDir)));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function logWebSelfId(
  authDir: string = resolveDefaultWebAuthDir(),
  runtime: RuntimeEnv = defaultRuntime,
  includeChannelPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid, lid } = readWebSelfId(authDir);
  const parts = [jid ? `jid ${jid}` : null, lid ? `lid ${lid}` : null].filter(
    (value): value is string => Boolean(value),
  );
  const details =
    e164 || parts.length > 0
      ? `${e164 ?? "unknown"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`
      : "unknown";
  const prefix = includeChannelPrefix ? "Web Channel: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickWebChannel(
  pref: WebChannel | "auto",
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<WebChannel> {
  const choice: WebChannel = pref === "auto" ? "web" : pref;
  const auth = await readWebAuthExistsForDecision(authDir);
  if (auth.outcome === "unstable") {
    throw new WhatsAppAuthUnstableError();
  }
  if (!auth.exists) {
    throw new Error(
      `No WhatsApp Web session found. Run \`${formatCliCommand("openclaw channels login --channel whatsapp --verbose")}\` to link.`,
    );
  }
  return choice;
}
