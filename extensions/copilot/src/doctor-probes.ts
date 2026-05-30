/**
 * Runtime doctor probes for the copilot extension.
 *
 * Imperative side-effecting checks used to diagnose a copilot
 * deployment from within `openclaw doctor` (or any equivalent
 * harness-side health check). Kept out of doctor-contract-api.ts
 * because that contract is declarative and auto-loaded by the
 * plugin registry, whereas these probes spawn subprocesses or
 * touch the filesystem and must be invoked imperatively.
 *
 * All probes are pure (no module-level state) and dependency-
 * injectable for tests. They never throw on a probe-negative
 * result — failure is surfaced via the `ok: false` shape so the
 * caller can render a structured doctor report.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ProbeResult<TPayload extends object = Record<string, never>> =
  | ({ ok: true } & TPayload)
  | { ok: false; reason: string; details?: Record<string, unknown> };

export interface ProbeCopilotCliVersionOptions {
  /** Command to invoke; defaults to "copilot". */
  command?: string;
  /** Argv used to ask for version; defaults to ["--version"]. */
  args?: readonly string[];
  /** Timeout in milliseconds; defaults to 5_000. */
  timeoutMs?: number;
  /** Injection seam for testing. Defaults to node:child_process spawn. */
  spawnFn?: typeof spawn;
}

export interface ProbeCopilotHomeOptions {
  /** Injection seam for testing. */
  fsApi?: Pick<typeof fs, "mkdir" | "writeFile" | "rm">;
  /** Filename used for the writability probe. */
  probeFileName?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_FILENAME = ".copilot-doctor-probe";

/**
 * Probe that the Copilot CLI is installed and prints a version.
 * Treats non-zero exit, missing stdout, and timeout all as failures.
 */
export async function probeCopilotCliVersion(
  options: ProbeCopilotCliVersionOptions = {},
): Promise<ProbeResult<{ version: string; command: string; rawStdout?: string }>> {
  const command = options.command ?? "copilot";
  const args = options.args ?? ["--version"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const spawnImpl = options.spawnFn ?? spawn;

  return new Promise<ProbeResult<{ version: string; command: string; rawStdout?: string }>>(
    (resolve) => {
      let child: ReturnType<typeof spawn> | undefined;
      let settled = false;
      const settle = (
        result: ProbeResult<{ version: string; command: string; rawStdout?: string }>,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        try {
          child?.kill();
        } catch {
          // ignore double-kill / already-dead errors
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle({
          ok: false,
          reason: "probe-timeout",
          details: { command, args: [...args], timeoutMs },
        });
      }, timeoutMs);

      try {
        child = spawnImpl(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        settle({
          ok: false,
          reason: "spawn-failed",
          details: { command, args: [...args], rawError: formatProbeError(error) },
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => {
        settle({
          ok: false,
          reason: "spawn-error",
          details: { command, args: [...args], rawError: error.message },
        });
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (code !== 0) {
          settle({
            ok: false,
            reason: "non-zero-exit",
            details: {
              command,
              args: [...args],
              exitCode: code,
              signal,
              stderr: stderr.trim() || undefined,
            },
          });
          return;
        }
        const rawStdout = stdout.trim();
        if (!rawStdout) {
          settle({
            ok: false,
            reason: "empty-version",
            details: { command, args: [...args] },
          });
          return;
        }
        // Many version commands (notably the GitHub Copilot CLI's `copilot --version`)
        // print a banner plus an "update available" hint on subsequent
        // lines. Surface only the first non-empty line as `version` so the
        // doctor UI gets a clean string; keep the full stdout in
        // `rawStdout` for debugging.
        const version = firstNonEmptyLine(rawStdout) ?? rawStdout;
        const payload: { version: string; command: string; rawStdout?: string } = {
          version,
          command,
        };
        if (rawStdout !== version) {
          payload.rawStdout = rawStdout;
        }
        settle({ ok: true, ...payload });
      });
    },
  );
}

function firstNonEmptyLine(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Probe that copilotHome (or default ~/.config/copilot) is writable
 * by the running user. Mirrors the existing auth-bridge's expectation
 * that the SDK can persist credentials under copilotHome.
 */
export async function probeCopilotHomeWritable(
  copilotHome: string | undefined,
  options: ProbeCopilotHomeOptions = {},
): Promise<ProbeResult<{ copilotHome: string; probedPath: string }>> {
  const fsApi = options.fsApi ?? fs;
  const probeFileName = options.probeFileName ?? DEFAULT_PROBE_FILENAME;
  const resolvedHome =
    typeof copilotHome === "string" && copilotHome.trim().length > 0
      ? copilotHome.trim()
      : defaultCopilotHome();
  const probedPath = path.join(resolvedHome, probeFileName);

  try {
    await fsApi.mkdir(resolvedHome, { recursive: true });
    await fsApi.writeFile(probedPath, "copilot-doctor-probe", "utf8");
    await fsApi.rm(probedPath, { force: true });
    return { ok: true, copilotHome: resolvedHome, probedPath };
  } catch (error) {
    return {
      ok: false,
      reason: "copilothome-not-writable",
      details: {
        copilotHome: resolvedHome,
        probedPath,
        rawError: formatProbeError(error),
      },
    };
  }
}

/**
 * Probe GitHub Copilot agent runtime auth resolution given a useLoggedInUser hint.
 * Validates that at least one of {useLoggedInUser, gitHubToken,
 * profileId+profileVersion} is set. This is intentionally a
 * shape-only probe: actually performing an SDK auth handshake
 * would require a pool and is out of scope for `openclaw doctor`.
 */
export function probeCopilotAuthShape(input: {
  useLoggedInUser?: boolean;
  gitHubToken?: string;
  profileId?: string;
  profileVersion?: string;
}): ProbeResult<{ resolvedMode: "useLoggedInUser" | "gitHubToken" | "profile" }> {
  if (input.useLoggedInUser === true) {
    return { ok: true, resolvedMode: "useLoggedInUser" };
  }
  if (typeof input.gitHubToken === "string" && input.gitHubToken.length > 0) {
    return { ok: true, resolvedMode: "gitHubToken" };
  }
  if (
    typeof input.profileId === "string" &&
    input.profileId.length > 0 &&
    typeof input.profileVersion === "string" &&
    input.profileVersion.length > 0
  ) {
    return { ok: true, resolvedMode: "profile" };
  }
  return {
    ok: false,
    reason: "no-auth-source",
    details: {
      hint: "Set useLoggedInUser:true, or gitHubToken, or both profileId+profileVersion",
    },
  };
}

function defaultCopilotHome(): string {
  // Mirrors the SDK convention; auth-bridge uses the same default.
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), "copilot");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "copilot");
  }
  return path.join(os.homedir(), ".config", "copilot");
}

function formatProbeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
