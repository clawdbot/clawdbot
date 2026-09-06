import { setTimeout as sleep } from "node:timers/promises";
import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { runExec } from "../process/exec.js";

const TAILSCALE_BACKEND_READY_WAIT_MS = 90_000;
const TAILSCALE_BACKEND_READY_POLL_MS = 2_000;
/** Backend states the daemon reports only while it is still coming up after boot. */
const TAILSCALE_BOOTING_BACKEND_STATES = new Set(["NoState", "Starting"]);

export function parsePossiblyNoisyJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    // SAFETY: callers only read string/object fields defensively from tailscale's JSON object output.
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  // SAFETY: same defensive field reads as above; a non-object payload fails those reads, not this cast.
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export function isTransientTailscaleStatusError(error: unknown): boolean {
  const record = readRecord(error);
  const detail = [
    error instanceof Error ? error.message : undefined,
    typeof record?.stderr === "string" ? record.stderr : undefined,
    typeof record?.stdout === "string" ? record.stdout : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  // The CLI's connect failure wording varies by platform and version: "local tailscaled",
  // "local tailscaled process", "local Tailscale service", "local Tailscale daemon". The
  // shared prefix is the stable contract (tailscale/cmd/tailscale/cli/diag.go).
  return (
    record?.timedOut === true ||
    detail.includes("failed to connect to local tailscale") ||
    detail.includes("connection refused") ||
    detail.includes("503 service unavailable")
  );
}

/**
 * Wait, bounded, while the local daemon is still booting (`NoState`/`Starting`, or not yet
 * accepting connections). Any other state, an unreadable status, or the deadline returns
 * immediately so the route claim itself reports the authoritative error.
 */
export async function waitForTailscaleBackendReady(params: {
  bin: string;
  prefix?: string[];
  info: (message: string) => void;
  exec?: typeof runExec;
  deadlineMs?: number;
  pollMs?: number;
}): Promise<void> {
  const exec = params.exec ?? runExec;
  const pollMs = params.pollMs ?? TAILSCALE_BACKEND_READY_POLL_MS;
  const deadline = Date.now() + (params.deadlineMs ?? TAILSCALE_BACKEND_READY_WAIT_MS);
  let announced: string | undefined;
  for (;;) {
    let pending: string;
    try {
      const { stdout } = await exec(params.bin, [...(params.prefix ?? []), "status", "--json"], {
        timeoutMs: 5000,
        maxBuffer: 400_000,
        logOutput: false,
      });
      const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
      const state = typeof parsed.BackendState === "string" ? parsed.BackendState : undefined;
      if (state === undefined || !TAILSCALE_BOOTING_BACKEND_STATES.has(state)) {
        return;
      }
      pending = state;
    } catch (error) {
      if (!isTransientTailscaleStatusError(error)) {
        return;
      }
      pending = "daemon not reachable";
    }
    if (Date.now() >= deadline) {
      return;
    }
    if (announced !== pending) {
      params.info(`waiting for the local Tailscale daemon (${pending})`);
      announced = pending;
    }
    await sleep(pollMs);
  }
}
