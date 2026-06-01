import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSandboxBrowserHashLabelFindings } from "./audit-extra.async.js";
import { collectSandboxDangerousConfigFindings } from "./audit-extra.sync.js";

function hasFinding(
  checkId:
    | "sandbox.browser_container.hash_label_missing"
    | "sandbox.browser_container.hash_epoch_stale"
    | "sandbox.browser_container.non_loopback_publish",
  severity: "warn" | "critical",
  findings: Array<{ checkId: string; severity: string; detail: string }>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function requireFinding(
  checkId: "sandbox.browser_container.hash_epoch_stale",
  findings: Array<{ checkId: string; severity: string; detail: string }>,
) {
  const finding = findings.find((entry) => entry.checkId === checkId);
  if (!finding) {
    throw new Error(`Expected ${checkId} finding`);
  }
  return finding;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("security audit sandbox browser findings", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns when sandbox browser containers have missing or stale hash labels", async () => {
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async (args: string[]) => {
        if (args[0] === "ps") {
          return {
            stdout: Buffer.from("openclaw-sbx-browser-old\nopenclaw-sbx-browser-missing-hash\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        if (args[0] === "inspect" && args.at(-1) === "openclaw-sbx-browser-old") {
          return {
            stdout: Buffer.from("abc123\tepoch-v0\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        if (args[0] === "inspect" && args.at(-1) === "openclaw-sbx-browser-missing-hash") {
          return {
            stdout: Buffer.from("<no value>\t<no value>\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("not found"),
          code: 1,
        };
      },
    });

    expect(hasFinding("sandbox.browser_container.hash_label_missing", "warn", findings)).toBe(true);
    expect(hasFinding("sandbox.browser_container.hash_epoch_stale", "warn", findings)).toBe(true);
    const staleEpoch = requireFinding("sandbox.browser_container.hash_epoch_stale", findings);
    expect(staleEpoch.detail).toContain("openclaw-sbx-browser-old");
  });

  it("skips sandbox browser hash label checks when docker inspect is unavailable", async () => {
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async () => {
        throw new Error("spawn docker ENOENT");
      },
    });
    expect(hasFinding("sandbox.browser_container.hash_label_missing", "warn", findings)).toBe(
      false,
    );
    expect(hasFinding("sandbox.browser_container.hash_epoch_stale", "warn", findings)).toBe(false);
  });

  it("bounds sandbox browser Docker probes that do not return", async () => {
    let probeSignal: AbortSignal | undefined;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });

    vi.useFakeTimers();
    const findingsPromise = collectSandboxBrowserHashLabelFindings({
      timeoutMs: 250,
      execDockerRawFn: async (_args, opts) => {
        probeSignal = opts?.signal;
        markProbeStarted();
        return await new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    await probeStarted;
    await vi.advanceTimersByTimeAsync(250);

    const findings = await findingsPromise;

    expect(probeSignal?.aborted).toBe(true);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "sandbox.browser_container.docker_probe_timeout",
        severity: "warn",
      }),
    ]);
  });

  it("stops probing remaining sandbox browser containers after a Docker timeout", async () => {
    const calls: string[] = [];
    let markHungProbeStarted!: () => void;
    const hungProbeStarted = new Promise<void>((resolve) => {
      markHungProbeStarted = resolve;
    });

    vi.useFakeTimers();
    const findingsPromise = collectSandboxBrowserHashLabelFindings({
      timeoutMs: 250,
      execDockerRawFn: async (args, opts) => {
        calls.push(`${args[0] ?? ""}:${args.at(-1) ?? ""}`);
        if (args[0] === "ps") {
          return {
            stdout: Buffer.from("openclaw-sbx-browser-hung\nopenclaw-sbx-browser-next\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        markHungProbeStarted();
        return await new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    await hungProbeStarted;
    await vi.advanceTimersByTimeAsync(250);

    const findings = await findingsPromise;

    expect(calls).toEqual(["ps:{{.Names}}", "inspect:openclaw-sbx-browser-hung"]);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "sandbox.browser_container.docker_probe_timeout",
      }),
    ]);
  });

  it("flags sandbox browser containers with non-loopback published ports", async () => {
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async (args: string[]) => {
        if (args[0] === "ps") {
          return {
            stdout: Buffer.from("openclaw-sbx-browser-exposed\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        if (args[0] === "inspect" && args.at(-1) === "openclaw-sbx-browser-exposed") {
          return {
            stdout: Buffer.from("hash123\t2026-02-21-novnc-auth-default\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        if (args[0] === "port" && args.at(-1) === "openclaw-sbx-browser-exposed") {
          return {
            stdout: Buffer.from("6080/tcp -> 0.0.0.0:49101\n9222/tcp -> 127.0.0.1:49100\n"),
            stderr: Buffer.alloc(0),
            code: 0,
          };
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("not found"),
          code: 1,
        };
      },
    });

    expect(hasFinding("sandbox.browser_container.non_loopback_publish", "critical", findings)).toBe(
      true,
    );
  });

  it("does not warn about cdpSourceRange since runtime auto-derives it", () => {
    const findings = collectSandboxDangerousConfigFindings({
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            browser: { enabled: true, network: "bridge" },
          },
        },
      },
    } satisfies OpenClawConfig);
    expect(findings.map((finding) => finding.checkId)).not.toContain(
      "sandbox.browser_cdp_bridge_unrestricted",
    );
  });
});
