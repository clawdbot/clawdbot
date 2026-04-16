import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ClaimableDedupe, createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";

// BlueBubbles has no sequence/ack in its webhook protocol, and its
// MessagePoller replays its ~1-week lookback window as `new-message` events
// after BB Server restarts or reconnects. Without persistent dedup, the
// gateway can reply to messages that were already handled before a restart
// (see issues #19176, #12053).
//
// TTL matches BB's lookback window so any replay is guaranteed to land on
// a remembered GUID, and the file-backed store survives gateway restarts.
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MEMORY_MAX_SIZE = 5_000;
const FILE_MAX_ENTRIES = 50_000;
// Cap GUID length so a malformed or hostile payload can't bloat the on-disk
// dedupe file. Real BB GUIDs are short (<64 chars); 512 is generous.
const MAX_GUID_CHARS = 512;

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VITEST || env.NODE_ENV === "test") {
    // Isolate tests from real ~/.openclaw state without sharing across tests.
    // Stable-per-pid so the scoped dedupe test can observe persistence.
    const name = "openclaw-vitest-" + process.pid;
    return path.join(resolvePreferredOpenClawTmpDir(), name);
  }
  // Canonical OpenClaw state dir: honors OPENCLAW_STATE_DIR (with `~` expansion
  // via resolveUserPath), plus legacy/new fallback. Using the shared helper
  // keeps this plugin's persistence aligned with the rest of OpenClaw state.
  return resolveStateDir(env);
}

function resolveLegacyNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "global";
  return path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe", `${safe}.json`);
}

function resolveNamespaceFilePath(namespace: string): string {
  // Keep a readable prefix for operator debugging, but suffix with a short
  // hash of the raw namespace so account IDs that only differ by
  // filesystem-unsafe characters (e.g. "acct/a" vs "acct:a") don't collapse
  // onto the same file.
  const safePrefix = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "ns";
  const hash = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 12);
  const dir = path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe");
  const newPath = path.join(dir, `${safePrefix}__${hash}.json`);

  // One-time migration: earlier beta shipped `${safe}.json` (no hash).
  // Rename so the upgrade preserves existing dedupe entries instead of
  // starting from an empty file and replaying already-handled messages.
  migrateLegacyDedupeFile(namespace, newPath);

  return newPath;
}

const migratedNamespaces = new Set<string>();

function migrateLegacyDedupeFile(namespace: string, newPath: string): void {
  if (migratedNamespaces.has(namespace)) {
    return;
  }
  migratedNamespaces.add(namespace);
  try {
    const legacyPath = resolveLegacyNamespaceFilePath(namespace);
    if (legacyPath === newPath) {
      return;
    }
    if (!fs.existsSync(legacyPath)) {
      return;
    }
    if (!fs.existsSync(newPath)) {
      fs.renameSync(legacyPath, newPath);
    } else {
      // Both exist: new file is authoritative; remove the stale legacy.
      fs.unlinkSync(legacyPath);
    }
  } catch {
    // Best-effort migration; a missed rename is strictly less harmful
    // than crashing the module load path.
  }
}

function buildPersistentImpl(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
    fileMaxEntries: FILE_MAX_ENTRIES,
    resolveFilePath: resolveNamespaceFilePath,
  });
}

function buildMemoryOnlyImpl(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
  });
}

let impl: ClaimableDedupe = buildPersistentImpl();

function sanitizeGuid(guid: string | undefined | null): string | null {
  const trimmed = guid?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_GUID_CHARS) {
    return null;
  }
  return trimmed;
}

/**
 * Resolve the canonical dedupe key for a BlueBubbles inbound message.
 *
 * Mirrors `monitor-debounce.ts`'s `buildKey`: BlueBubbles sends URL-preview
 * / sticker "balloon" events with a different `messageId` than the text
 * message they belong to, and the debouncer coalesces the two only when
 * both `balloonBundleId` AND `associatedMessageGuid` are present. We gate
 * on the same pair so that regular replies — which also set
 * `associatedMessageGuid` (pointing at the parent message) but have no
 * `balloonBundleId` — are NOT collapsed onto their parent's dedupe key.
 *
 * Known tradeoff: `combineDebounceEntries` clears `balloonBundleId` on
 * merged entries while keeping `associatedMessageGuid`, so a post-merge
 * balloon+text message here will fall back to its `messageId`. A later
 * MessagePoller replay that arrives in a different text-first/balloon-first
 * order could therefore produce a different `messageId` at merge time and
 * bypass this dedupe for that one message. That edge case is strictly
 * narrower than the alternative — which would dedupe every distinct user
 * reply against the same parent GUID and silently drop real messages.
 */
export function resolveBlueBubblesInboundDedupeKey(
  message: Pick<
    NormalizedWebhookMessage,
    "messageId" | "balloonBundleId" | "associatedMessageGuid"
  >,
): string | undefined {
  const balloonBundleId = message.balloonBundleId?.trim();
  const associatedMessageGuid = message.associatedMessageGuid?.trim();
  if (balloonBundleId && associatedMessageGuid) {
    return associatedMessageGuid;
  }
  return message.messageId?.trim() || undefined;
}

export type InboundDedupeClaim =
  | { kind: "claimed"; finalize: () => Promise<void>; release: () => void }
  | { kind: "duplicate" }
  | { kind: "inflight" }
  | { kind: "skip" };

/**
 * Attempt to claim an inbound BlueBubbles message GUID.
 *
 * - `claimed`: caller should process the message, then call `finalize()` on
 *   success (persists the GUID) or `release()` on failure (lets a later
 *   replay try again).
 * - `duplicate`: we've already committed this GUID; caller should drop.
 * - `inflight`: another claim is currently in progress; caller should drop
 *   rather than race.
 * - `skip`: GUID was missing or invalid — caller should continue processing
 *   without dedup (no finalize/release needed).
 */
export async function claimBlueBubblesInboundMessage(params: {
  guid: string | undefined | null;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<InboundDedupeClaim> {
  const normalized = sanitizeGuid(params.guid);
  if (!normalized) {
    return { kind: "skip" };
  }
  const claim = await impl.claim(normalized, {
    namespace: params.accountId,
    onDiskError: params.onDiskError,
  });
  if (claim.kind === "duplicate") {
    return { kind: "duplicate" };
  }
  if (claim.kind === "inflight") {
    return { kind: "inflight" };
  }
  return {
    kind: "claimed",
    finalize: async () => {
      await impl.commit(normalized, {
        namespace: params.accountId,
        onDiskError: params.onDiskError,
      });
    },
    release: () => {
      impl.release(normalized, { namespace: params.accountId });
    },
  };
}

/**
 * Ensure the legacy→hashed dedupe file migration runs and the on-disk
 * store is warmed into memory for the given account. Call before any
 * catchup replay so already-handled GUIDs are recognized even when the
 * file-naming convention changed between versions.
 */
export async function warmupBlueBubblesInboundDedupe(accountId: string): Promise<void> {
  // Trigger the migration side-effect inside resolveNamespaceFilePath.
  resolveNamespaceFilePath(accountId);
  await impl.warmup(accountId);
}

/**
 * Reset inbound dedupe state between tests. Installs an in-memory-only
 * implementation so tests do not hit disk, avoiding file-lock timing issues
 * in the webhook flush path.
 */
export function _resetBlueBubblesInboundDedupForTest(): void {
  impl = buildMemoryOnlyImpl();
}
