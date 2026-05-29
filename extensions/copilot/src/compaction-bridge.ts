import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfig } from "@github/copilot-sdk";

// Compaction bridge for the GitHub Copilot agent runtime.
//
// Two responsibilities:
//
//   1. Shape `SessionConfig.infiniteSessions` from a typed options bag
//      so attempt.ts can opt the SDK in to background auto-compaction
//      at session creation. The SDK manages the actual compaction
//      under the `infiniteSessions` config (background at
//      `backgroundCompactionThreshold`, blocking at
//      `bufferExhaustionThreshold`).
//
//   2. Write an OpenClaw-shaped JSON marker file at
//      `<workspaceDir>/files/openclaw-compaction-<sessionId>-<ts>.json`
//      whenever the host calls `harness.compact(params)`. Existing
//      OpenClaw transcript readers look in `workspacePath/files/` for
//      compaction artifacts; the marker keeps them informed even
//      though the SDK now owns the actual context-window mechanics
//      under infiniteSessions.
//
// Host back-pointers (NOT imported here to keep the package boundary
// clean):
//   - `src/agents/pi-embedded-runner/compact.types.ts` — canonical
//     `CompactEmbeddedPiSessionParams`.
//   - `src/agents/pi-embedded-runner/types.ts` — canonical
//     `EmbeddedPiCompactResult`.

type SdkInfiniteSessionConfig = NonNullable<SessionConfig["infiniteSessions"]>;

export type { SdkInfiniteSessionConfig as CopilotInfiniteSessionConfig };

export interface CopilotInfiniteSessionOptions {
  enabled?: boolean;
  backgroundCompactionThreshold?: number;
  bufferExhaustionThreshold?: number;
}

/**
 * Shape an `InfiniteSessionConfig` for `SessionConfig.infiniteSessions`.
 * Returns `undefined` when no fields were supplied so callers can
 * spread conditionally and let the SDK apply its own defaults
 * (`enabled: true`, background 0.80, buffer 0.95). Any explicitly-set
 * value (including `enabled: false` to disable infinite sessions) is
 * preserved.
 */
export function createInfiniteSessionConfig(
  options?: CopilotInfiniteSessionOptions,
): SdkInfiniteSessionConfig | undefined {
  if (!options) {
    return undefined;
  }
  const result: SdkInfiniteSessionConfig = {};
  if (options.enabled !== undefined) {
    result.enabled = options.enabled;
  }
  if (options.backgroundCompactionThreshold !== undefined) {
    result.backgroundCompactionThreshold = options.backgroundCompactionThreshold;
  }
  if (options.bufferExhaustionThreshold !== undefined) {
    result.bufferExhaustionThreshold = options.bufferExhaustionThreshold;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface OpenClawCompactionMarkerInput {
  /** OpenClaw session id (CompactEmbeddedPiSessionParams.sessionId). */
  readonly sessionId: string;
  /** Workspace dir (CompactEmbeddedPiSessionParams.workspaceDir). */
  readonly workspaceDir: string;
  /** Compaction trigger from CompactEmbeddedPiSessionParams.trigger. */
  readonly trigger?: "budget" | "overflow" | "manual";
  /** Optional caller-observed token count at compaction time. */
  readonly currentTokenCount?: number;
  /** Optional active SDK session id when the marker is written. */
  readonly sdkSessionId?: string;
  /** Optional reason string for the marker. */
  readonly reason?: string;
  /**
   * Whether the host passed `force: true` in CompactEmbeddedPiSessionParams.
   * Recorded for diagnostics — the harness cannot synchronously force
   * compaction since the SDK has no on-demand compact RPC.
   */
  readonly force?: boolean;
}

export interface OpenClawCompactionMarkerOptions {
  /** Override `Date.now`. Default: `Date.now`. */
  readonly now?: () => number;
  /** Override `node:fs/promises` writers. Useful in tests. */
  readonly fs?: Pick<typeof import("node:fs/promises"), "mkdir" | "writeFile">;
  /**
   * Subdirectory under workspaceDir that holds the markers. Default
   * `files` to match the proposal-defined location.
   */
  readonly subdir?: string;
}

export interface OpenClawCompactionMarker {
  readonly version: 1;
  readonly source: "copilot-harness";
  readonly sessionId: string;
  readonly ts: number;
  /**
   * Whether actual compaction occurred. Always false from the harness
   * path: SDK auto-compaction runs asynchronously in the background
   * and the harness does not synchronously force it.
   */
  readonly compacted: false;
  readonly trigger?: "budget" | "overflow" | "manual";
  readonly force?: boolean;
  readonly sdkSessionId?: string;
  readonly currentTokenCount?: number;
  readonly reason?: string;
}

export interface WrittenOpenClawCompactionMarker {
  readonly path: string;
  readonly marker: OpenClawCompactionMarker;
}

function compactJsonValue<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Write an OpenClaw-shaped compaction marker JSON file under
 * `<workspaceDir>/<subdir>/openclaw-compaction-<sessionId>-<ts>.json`.
 *
 * Returns the resolved file path and the marker payload that was
 * written. Throws if the workspaceDir or sessionId is missing/empty
 * (the caller should not invoke this without those — the harness
 * `compact()` must validate first).
 */
export async function writeOpenClawCompactionMarker(
  input: OpenClawCompactionMarkerInput,
  options: OpenClawCompactionMarkerOptions = {},
): Promise<WrittenOpenClawCompactionMarker> {
  if (!input.workspaceDir || typeof input.workspaceDir !== "string") {
    throw new Error("[copilot:compaction-bridge] workspaceDir is required to write a marker");
  }
  if (!input.sessionId || typeof input.sessionId !== "string") {
    throw new Error("[copilot:compaction-bridge] sessionId is required to write a marker");
  }

  const now = options.now ?? Date.now;
  const fs = options.fs ?? { mkdir, writeFile };
  const subdir = options.subdir ?? "files";
  const ts = now();
  const safeSessionId = input.sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Filename pattern: ts-first so listings sort chronologically. Suffix
  // sessionId for collision safety when multiple sessions share a
  // workspace. Matches the proposal's `openclaw-compaction-<ts>` prefix.
  const filename = `openclaw-compaction-${ts}-${safeSessionId}.json`;
  const dirPath = join(input.workspaceDir, subdir);
  const filePath = join(dirPath, filename);

  const marker: OpenClawCompactionMarker = compactJsonValue({
    version: 1 as const,
    source: "copilot-harness" as const,
    sessionId: input.sessionId,
    ts,
    compacted: false as const,
    trigger: input.trigger,
    force: input.force,
    sdkSessionId: input.sdkSessionId,
    currentTokenCount: input.currentTokenCount,
    reason: input.reason,
  });

  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  return { path: filePath, marker };
}
