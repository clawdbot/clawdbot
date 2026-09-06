// Covers install-policy checks for packages and plugin installs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  killPidIfAlive,
  waitForPidFile,
  waitForPidToExit,
  writeForkingNoOutputScript,
} from "../test-utils/process-tree.js";
import { runInstallPolicy, validateInstallPolicyStatic } from "./install-policy.js";

type InstallPolicyRequest = Parameters<typeof runInstallPolicy>[0]["request"];

async function writePolicyScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "policy.cjs");
  await fs.writeFile(
    scriptPath,
    `#!${process.execPath}
const fs = require("node:fs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (process.env.OUT_FILE) {
    fs.writeFileSync(process.env.OUT_FILE, input);
  }
  if (process.env.CWD_FILE) {
    fs.writeFileSync(process.env.CWD_FILE, process.cwd());
  }
  if (process.env.ENV_FILE) {
    fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({
      PATH: process.env.PATH,
      Path: process.env.Path,
    }));
  }
  if (process.env.STDERR_TEXT) {
    process.stderr.write(process.env.STDERR_TEXT);
  }
  if (process.env.EXIT_CODE) {
    process.exit(Number(process.env.EXIT_CODE));
  }
  process.stdout.write(process.env.POLICY_RESPONSE || "");
});
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

async function writeEnvNodePolicyScript(dir: string): Promise<string> {
  const envNodeScriptPath = path.join(dir, "env-node-policy");
  await fs.writeFile(
    envNodeScriptPath,
    `#!/usr/bin/env node
process.stdout.write(process.env.POLICY_RESPONSE || "");
`,
    "utf8",
  );
  await fs.chmod(envNodeScriptPath, 0o700);
  return envNodeScriptPath;
}

function baseRequest(sourcePath: string): InstallPolicyRequest {
  return {
    targetType: "skill",
    targetName: "weather",
    sourcePath,
    sourcePathKind: "directory",
    source: { kind: "clawhub", authority: "openclaw", mutable: false, network: true },
    origin: { type: "clawhub", slug: "weather", version: "1.0.0" },
    request: {
      kind: "skill-install",
      mode: "install",
      requestedSpecifier: "clawhub:weather@1.0.0",
    },
    skill: {
      installId: "clawhub",
    },
  };
}

function configWithPolicy(scriptPath: string, env: Record<string, string>): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec",
          command: scriptPath,
          env,
          trustedDirs: [path.dirname(scriptPath)],
          timeoutMs: 5000,
          maxOutputBytes: 16 * 1024,
        },
      },
    },
  };
}

describe("runInstallPolicy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let sourceDir: string;
  let scriptPath: string;

  beforeEach(async () => {
    sourceDir = tempDirs.make("openclaw-install-policy-");
    scriptPath = await writePolicyScript(sourceDir);
  });

  it("does nothing when install policy is disabled", async () => {
    await expect(runInstallPolicy({ config: {}, request: baseRequest(sourceDir) })).resolves.toBe(
      undefined,
    );
  });

  it("does nothing when install policy is present but not enabled", async () => {
    await expect(
      runInstallPolicy({
        config: {
          security: {
            installPolicy: {},
          },
        },
        request: baseRequest(sourceDir),
      }),
    ).resolves.toBe(undefined);
  });

  it("executes policy for skills when targets are omitted", async () => {
    const capturePath = path.join(sourceDir, "request.json");
    const cwdPath = path.join(sourceDir, "cwd.txt");
    const response = JSON.stringify({ protocolVersion: 1, decision: "allow" });

    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        CWD_FILE: cwdPath,
        OUT_FILE: capturePath,
        POLICY_RESPONSE: response,
      }),
      request: baseRequest(sourceDir),
    });

    expect(result).toEqual({});
    const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, unknown>;
    expect(captured.protocolVersion).toBe(1);
    expect(captured.openclawVersion).toEqual(expect.any(String));
    expect(captured.targetType).toBe("skill");
    expect(captured.sourcePath).toBe(sourceDir);
    expect(captured.source).toEqual({
      kind: "clawhub",
      authority: "openclaw",
      mutable: false,
      network: true,
    });
    await expect(fs.readFile(cwdPath, "utf8")).resolves.toBe(
      await fs.realpath(path.dirname(scriptPath)),
    );
    expect(captured.request).toMatchObject({
      kind: "skill-install",
      mode: "install",
      requestedSpecifier: "clawhub:weather@1.0.0",
    });
    expect(captured.origin).toMatchObject({ type: "clawhub", slug: "weather" });
  });

  it("preserves PATH so env shebang policy scripts can start", async () => {
    if (process.platform === "win32") {
      return;
    }
    const envNodeScriptPath = await writeEnvNodePolicyScript(sourceDir);
    const response = JSON.stringify({ protocolVersion: 1, decision: "allow" });

    const result = await runInstallPolicy({
      config: {
        security: {
          installPolicy: {
            enabled: true,
            exec: {
              source: "exec",
              command: envNodeScriptPath,
              env: {
                POLICY_RESPONSE: response,
              },
              passEnv: ["PATH"],
              trustedDirs: [path.dirname(envNodeScriptPath)],
            },
          },
        },
      },
      env: {
        PATH: path.dirname(requireNodeTool("node")),
      },
      request: baseRequest(sourceDir),
    });

    expect(result).toEqual({});
  });

  it.runIf(process.platform !== "win32")(
    "kills forked policy command children on no-output timeout",
    async () => {
      const forkScriptPath = await writeForkingNoOutputScript(sourceDir);
      const pidPath = path.join(sourceDir, "forked.pid");
      let childPid: number | undefined;
      const nativeSetTimeout = globalThis.setTimeout;
      const noOutputTimeouts: Array<() => void> = [];
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          if (delay === 1_000) {
            noOutputTimeouts.push(() => callback(...args));
            return nativeSetTimeout(() => undefined, 60_000);
          }
          return nativeSetTimeout(callback, delay, ...args);
        });

      try {
        const resultPromise = runInstallPolicy({
          config: {
            security: {
              installPolicy: {
                enabled: true,
                exec: {
                  source: "exec",
                  command: forkScriptPath,
                  env: { NODE_BINARY: process.execPath, PID_FILE: pidPath },
                  trustedDirs: [path.dirname(forkScriptPath)],
                  noOutputTimeoutMs: 1_000,
                  timeoutMs: 10_000,
                },
              },
            },
          },
          request: baseRequest(sourceDir),
        });
        void resultPromise.catch(() => undefined);
        childPid = await waitForPidFile(pidPath);
        await vi.waitFor(
          () => {
            expect(noOutputTimeouts.length).toBeGreaterThanOrEqual(2);
          },
          { timeout: 5_000 },
        );
        noOutputTimeouts.at(-1)?.();
        const result = await resultPromise;

        expect(result?.blocked?.reason).toContain("policy command produced no output");
        expect(await waitForPidToExit(childPid, 5_000)).toBe(true);
      } finally {
        setTimeoutSpy.mockRestore();
        killPidIfAlive(childPid);
      }
    },
  );

  it("does not inherit PATH unless passEnv includes it", async () => {
    const envPath = path.join(sourceDir, "env.json");
    const response = JSON.stringify({ protocolVersion: 1, decision: "allow" });

    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        ENV_FILE: envPath,
        POLICY_RESPONSE: response,
      }),
      env: {
        PATH: "/tmp/untrusted-path",
      },
      request: baseRequest(sourceDir),
    });

    expect(result).toEqual({});
    const captured = JSON.parse(await fs.readFile(envPath, "utf8")) as {
      PATH?: string;
      Path?: string;
    };
    expect(captured.PATH).toBeUndefined();
    expect(captured.Path).toBeUndefined();
  });

  it("skips skill requests when targets only include plugins", async () => {
    const config: OpenClawConfig = {
      security: {
        installPolicy: {
          enabled: true,
          targets: ["plugin"],
          exec: {
            source: "exec",
            command: process.execPath,
            args: [scriptPath],
            env: {
              EXIT_CODE: "1",
            },
            trustedDirs: [path.dirname(scriptPath)],
          },
        },
      },
    };

    await expect(runInstallPolicy({ config, request: baseRequest(sourceDir) })).resolves.toBe(
      undefined,
    );
  });

  it("prefixes operator blocks", async () => {
    const debugLogs: string[] = [];
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "block",
          reason: "unapproved registry",
        }),
      }),
      logger: { debug: (message) => debugLogs.push(message) },
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked).toEqual({
      code: "security_scan_blocked",
      reason: "blocked by install policy: unapproved registry",
    });
    expect(debugLogs.join("\n")).toContain("target=skill:weather");
    expect(debugLogs.join("\n")).toContain("source=clawhub/openclaw");
    expect(debugLogs.join("\n")).toContain("blocked by install policy");
  });

  it("keeps truncated operator block reasons UTF-16 safe", async () => {
    const reasonPrefix = "r".repeat(999);
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "block",
          reason: `${reasonPrefix}🎉tail`,
        }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked).toEqual({
      code: "security_scan_blocked",
      reason: `blocked by install policy: ${reasonPrefix.slice(0, 997)}...`,
    });
  });

  it("preserves allow findings without file or line", async () => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "allow",
          findings: [
            {
              ruleId: "registry-review",
              severity: "warn",
              message: "Registry requires review.",
            },
          ],
        }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result).toStrictEqual({
      findings: [
        {
          ruleId: "registry-review",
          severity: "warn",
          message: "Registry requires review.",
        },
      ],
    });
  });

  it("keeps valid findings while dropping malformed fields through schema parsing", async () => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "allow",
          findings: [
            {
              ruleId: "  registry-review  ",
              severity: "warn",
              message: "  Registry requires review.  ",
              file: 42,
              line: "7",
              evidence: false,
            },
            { ruleId: 42, severity: "warn", message: "invalid required field" },
          ],
        }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result).toStrictEqual({
      findings: [
        {
          ruleId: "registry-review",
          severity: "warn",
          message: "Registry requires review.",
        },
      ],
    });
  });

  it("returns warnings with their reason and findings", async () => {
    const debugLogs: string[] = [];
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "warn",
          reason: "review this source",
          findings: [
            {
              ruleId: "manual-review",
              severity: "warn",
              message: "Suspicious install script.",
            },
          ],
        }),
      }),
      logger: { debug: (message) => debugLogs.push(message) },
      request: baseRequest(sourceDir),
    });

    expect(result).toEqual({
      warning: {
        reason: "review this source",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      findings: [
        {
          ruleId: "manual-review",
          severity: "warn",
          message: "Suspicious install script.",
        },
      ],
    });
    expect(debugLogs.filter((message) => message.endsWith(": warned"))).toHaveLength(1);
  });

  it("normalizes warning finding lines to positive safe integers", async () => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "warn",
          reason: "review line normalization",
          findings: [-2, 12.9, 1e100].map((line, index) => ({
            ruleId: `line-${String(index)}`,
            severity: "warn",
            message: "Review line",
            line,
          })),
        }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result?.findings?.map((finding) => finding.line)).toEqual([
      1,
      12,
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  it("bounds operator-facing warning text without splitting surrogate pairs", async () => {
    const longText = `${"x".repeat(996)}😀${"y".repeat(100)}`;
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "warn",
          reason: longText,
          findings: [
            {
              ruleId: longText,
              severity: "warn",
              message: longText,
              file: longText,
              evidence: longText,
            },
          ],
        }),
      }),
      request: baseRequest(sourceDir),
    });

    const boundedText = [
      result?.warning?.reason,
      result?.findings?.[0]?.ruleId,
      result?.findings?.[0]?.message,
      result?.findings?.[0]?.file,
      result?.findings?.[0]?.evidence,
    ];
    for (const value of boundedText) {
      expect(value).toBeDefined();
      expect(value?.length).toBeLessThanOrEqual(1_000);
      expect(value?.endsWith("...")).toBe(true);
      expect(value?.slice(0, -3)).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("fingerprints warning reason changes beyond the display limit", async () => {
    const sharedPrefix = "r".repeat(1000);
    const runWarning = async (reason: string) =>
      await runInstallPolicy({
        config: configWithPolicy(scriptPath, {
          POLICY_RESPONSE: JSON.stringify({ protocolVersion: 1, decision: "warn", reason }),
        }),
        request: baseRequest(sourceDir),
      });

    const first = await runWarning(`${sharedPrefix}-first`);
    const second = await runWarning(`${sharedPrefix}-second`);

    expect(first?.warning?.reason).toBe(second?.warning?.reason);
    expect(first?.warning?.fingerprint).not.toBe(second?.warning?.fingerprint);
  });

  it("fails closed when a warning has more valid findings than can be reviewed", async () => {
    const findings = Array.from({ length: 101 }, (_, index) => ({
      ruleId: `finding-${String(index)}`,
      severity: "warn",
      message: `Finding ${String(index)}`,
    }));
    const runWarning = async (warningFindings: typeof findings) =>
      await runInstallPolicy({
        config: configWithPolicy(scriptPath, {
          POLICY_RESPONSE: JSON.stringify({
            protocolVersion: 1,
            decision: "warn",
            reason: "review all findings",
            findings: warningFindings,
          }),
        }),
        request: baseRequest(sourceDir),
      });

    const boundary = await runWarning(findings.slice(0, 100));
    const result = await runWarning(findings);

    expect(boundary?.warning).toBeDefined();
    expect(boundary?.findings).toHaveLength(100);
    expect(result?.blocked?.code).toBe("security_scan_failed");
    expect(result?.blocked?.reason).toContain("more than 100 valid findings");
    expect(result?.warning).toBeUndefined();
    expect(result?.findings).toBeUndefined();
  });

  it("selects display findings after dropping malformed entries", async () => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "warn",
          reason: "review valid findings",
          findings: [
            ...Array.from({ length: 100 }, () => ({ severity: "warn", message: "invalid" })),
            {
              ruleId: "valid-after-malformed-prefix",
              severity: "critical",
              message: "Review this critical finding.",
            },
          ],
        }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result?.warning).toEqual({
      reason: "review valid findings",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result?.findings).toEqual([
      {
        ruleId: "valid-after-malformed-prefix",
        severity: "critical",
        message: "Review this critical finding.",
      },
    ]);
  });

  it.each([
    { label: "missing", reason: undefined },
    { label: "empty", reason: "  " },
    { label: "non-string", reason: 42 },
  ])("fails closed when a warning has a $label reason", async ({ reason }) => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({ protocolVersion: 1, decision: "warn", reason }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked?.code).toBe("security_scan_failed");
    expect(result?.blocked?.reason).toContain('decision "warn" requires a non-empty reason');
  });

  it("preserves block findings without file or line", async () => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify({
          protocolVersion: 1,
          decision: "block",
          reason: "unapproved registry",
          findings: [
            {
              ruleId: "registry-review",
              severity: "critical",
              message: "Registry is not approved.",
            },
          ],
        }),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by install policy: unapproved registry",
      },
      findings: [
        {
          ruleId: "registry-review",
          severity: "critical",
          message: "Registry is not approved.",
        },
      ],
    });
  });

  it.each([
    { label: "non-object", response: [], expected: "must be a JSON object" },
    {
      label: "unsupported protocol version",
      response: { protocolVersion: 2, decision: "allow" },
      expected: "protocolVersion must be 1",
    },
    {
      label: "unknown decision",
      response: { protocolVersion: 1, decision: "review" },
      expected: 'decision must be "allow", "warn", or "block"',
    },
  ])("fails closed for a $label response", async ({ response, expected }) => {
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: JSON.stringify(response),
      }),
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked?.code).toBe("security_scan_failed");
    expect(result?.blocked?.reason).toContain(expected);
  });

  it("fails closed on malformed policy output", async () => {
    const debugLogs: string[] = [];
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        POLICY_RESPONSE: "not json",
      }),
      logger: { debug: (message) => debugLogs.push(message) },
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked?.code).toBe("security_scan_failed");
    expect(result?.blocked?.reason).toContain("install policy failed closed");
    expect(result?.blocked?.reason).toContain("invalid JSON");
    expect(debugLogs.join("\n")).toContain("install policy failed closed");
  });

  it("does not expose policy command stderr in fail-closed reasons", async () => {
    const debugLogs: string[] = [];
    const result = await runInstallPolicy({
      config: configWithPolicy(scriptPath, {
        EXIT_CODE: "7",
        STDERR_TEXT: "policy-secret-token",
      }),
      logger: { debug: (message) => debugLogs.push(message) },
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked?.code).toBe("security_scan_failed");
    expect(result?.blocked?.reason).toContain("policy command exited with code 7");
    expect(result?.blocked?.reason).not.toContain("policy-secret-token");
    expect(debugLogs.join("\n")).not.toContain("policy-secret-token");
  });

  it("rejects relative policy command paths before resolving cwd", async () => {
    const result = await runInstallPolicy({
      config: {
        security: {
          installPolicy: {
            enabled: true,
            exec: {
              source: "exec",
              command: "policy.cjs",
              args: [],
            },
          },
        },
      },
      request: baseRequest(sourceDir),
    });

    expect(result?.blocked?.code).toBe("security_scan_failed");
    expect(result?.blocked?.reason).toContain(
      "security.installPolicy.exec.command must be an absolute path",
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects Windows-style policy command paths on POSIX",
    async () => {
      const result = await runInstallPolicy({
        config: {
          security: {
            installPolicy: {
              enabled: true,
              exec: {
                source: "exec",
                command: "C:\\tmp\\policy.cjs",
                args: [],
              },
            },
          },
        },
        request: baseRequest(sourceDir),
      });

      expect(result?.blocked?.code).toBe("security_scan_failed");
      expect(result?.blocked?.reason).toContain(
        "security.installPolicy.exec.command must be an absolute path",
      );
    },
  );

  it("reports static validation issues without running policy command", async () => {
    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: "policy.cjs",
          },
        },
      },
    });

    expect(validation).toMatchObject({
      enabled: true,
      targets: ["skill", "plugin"],
    });
    expect(validation.issues.map((issue) => issue.message)).toContain(
      "security.installPolicy.exec.command must be an absolute path.",
    );
  });

  it("rejects policy commands under writable parent directories", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDirs.make("openclaw-install-policy-");
    const writableDir = path.join(dir, "writable-parent");
    await fs.mkdir(writableDir, { recursive: true });
    await fs.chmod(writableDir, 0o777);
    const writableScriptPath = await writePolicyScript(writableDir);

    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: writableScriptPath,
          },
        },
      },
    });

    expect(validation.issues.map((issue) => issue.message)).toContain(
      `security.installPolicy.exec.command parent directory permissions are too open: ${writableDir}`,
    );
  });

  it("rejects policy interpreter script args under writable parent directories", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDirs.make("openclaw-install-policy-");
    const writableDir = path.join(dir, "writable-parent");
    await fs.mkdir(writableDir, { recursive: true });
    await fs.chmod(writableDir, 0o777);
    const writableScriptPath = await writePolicyScript(writableDir);

    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: [writableScriptPath],
          },
        },
      },
    });

    expect(validation.issues.map((issue) => issue.message)).toContain(
      `security.installPolicy.exec.args[0] parent directory permissions are too open: ${writableDir}`,
    );
  });

  it("validates later interpreter script args after path-taking options", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDirs.make("openclaw-install-policy-");
    const writableDir = path.join(dir, "writable-parent");
    await fs.mkdir(writableDir, { recursive: true });
    await fs.chmod(writableDir, 0o777);
    const writableScriptPath = await writePolicyScript(writableDir);

    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: ["--require", scriptPath, writableScriptPath],
          },
        },
      },
    });

    expect(validation.issues.map((issue) => issue.message)).toContain(
      `security.installPolicy.exec.args[2] parent directory permissions are too open: ${writableDir}`,
    );
  });

  it("validates interpreter option values that embed script paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDirs.make("openclaw-install-policy-");
    const writableDir = path.join(dir, "writable-parent");
    await fs.mkdir(writableDir, { recursive: true });
    await fs.chmod(writableDir, 0o777);
    const writableScriptPath = await writePolicyScript(writableDir);

    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: [`--require=${writableScriptPath}`, scriptPath],
          },
        },
      },
    });

    expect(validation.issues.map((issue) => issue.message)).toContain(
      `security.installPolicy.exec.args[0] parent directory permissions are too open: ${writableDir}`,
    );
  });

  it.runIf(process.platform !== "win32")("rejects symlinked interpreter script args", async () => {
    const dir = tempDirs.make("openclaw-install-policy-");
    const realScriptPath = await writePolicyScript(dir);
    const symlinkScriptPath = path.join(dir, "policy-link.cjs");
    await fs.symlink(realScriptPath, symlinkScriptPath);

    const validation = await validateInstallPolicyStatic({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: process.execPath,
            args: [symlinkScriptPath],
          },
        },
      },
    });

    expect(validation.issues.map((issue) => issue.message)).toContain(
      `security.installPolicy.exec.args[0] must not be a symlink: ${symlinkScriptPath}`,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects env policy commands before interpreter resolution can bypass validation",
    async () => {
      const validation = await validateInstallPolicyStatic({
        security: {
          installPolicy: {
            enabled: true,
            exec: {
              source: "exec",
              command: "/usr/bin/env",
              args: ["-S", `node ${scriptPath}`],
            },
          },
        },
      });

      expect(validation.issues.map((issue) => issue.message)).toContain(
        "security.installPolicy.exec.command must not use env; configure the policy executable directly.",
      );
    },
  );
});
