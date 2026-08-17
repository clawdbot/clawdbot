import { describe, expect, it } from "vitest";
import {
  PRECHECK_NO_WORK_REASON,
  PRECHECK_SKIPPED_ERROR_REASON,
  PRECHECK_POLICY_DENIED_REASON,
  authorizeCronJobPrecheckCommand,
  cronRunOutcomeFromPrecheck,
  interpretPrecheckOutput,
  normalizeCronJobPrecheck,
  runCronJobPrecheck,
} from "./job-precheck.js";

describe("interpretPrecheckOutput", () => {
  it("treats exit 0 as work and exit 2 as no-work by default", () => {
    expect(interpretPrecheckOutput({ exitCode: 0, stdout: "", stderr: "" }).decision).toBe("run");
    const skip = interpretPrecheckOutput({ exitCode: 2, stdout: "", stderr: "" });
    expect(skip.decision).toBe("skip");
    if (skip.decision === "skip") {
      expect(skip.reason).toBe(PRECHECK_NO_WORK_REASON);
    }
  });

  it("honors WORK_NEEDED / NO_WORK prefixes over exit code", () => {
    expect(
      interpretPrecheckOutput({
        exitCode: 2,
        stdout: "WORK_NEEDED: dirty prs\n",
        stderr: "",
      }).decision,
    ).toBe("run");
    expect(
      interpretPrecheckOutput({
        exitCode: 0,
        stdout: "NO_WORK\n",
        stderr: "",
      }).decision,
    ).toBe("skip");
  });

  it("maps unexpected exits to error (or skip when onError=skip)", () => {
    expect(interpretPrecheckOutput({ exitCode: 7, stdout: "", stderr: "boom" }).decision).toBe(
      "error",
    );
    const skippedError = interpretPrecheckOutput({
      exitCode: 7,
      stdout: "",
      stderr: "boom",
      onError: "skip",
    });
    expect(skippedError.decision).toBe("skip");
    if (skippedError.decision === "skip") {
      expect(skippedError.reason).toBe(PRECHECK_SKIPPED_ERROR_REASON);
      expect(skippedError.reason).not.toBe(PRECHECK_NO_WORK_REASON);
    }
  });
});

describe("cronRunOutcomeFromPrecheck", () => {
  it("emits skipped outcome with stable reason for no-work", () => {
    const outcome = cronRunOutcomeFromPrecheck({
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: 2,
      stdout: "NO_WORK",
      stderr: "",
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.error).toBe(PRECHECK_NO_WORK_REASON);
    expect(outcome.diagnostics?.summary).toBe(PRECHECK_NO_WORK_REASON);
  });

  it("preserves skipped-error reason distinct from no-work (onError=skip)", () => {
    const outcome = cronRunOutcomeFromPrecheck({
      decision: "skip",
      reason: PRECHECK_SKIPPED_ERROR_REASON,
      exitCode: 7,
      stdout: "",
      stderr: "boom",
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.error).toBe(PRECHECK_SKIPPED_ERROR_REASON);
    expect(outcome.diagnostics?.summary).toBe(PRECHECK_SKIPPED_ERROR_REASON);
    expect(outcome.error).not.toBe(PRECHECK_NO_WORK_REASON);
  });
});

describe("normalizeCronJobPrecheck", () => {
  it("rejects overlapping work and no-work exit codes", () => {
    expect(() =>
      normalizeCronJobPrecheck({
        command: "echo hi",
        workExitCodes: [0, 2],
        noWorkExitCodes: [2, 3],
      }),
    ).toThrow(/must not overlap/);
  });

  it("requires a command and normalizes kinds", () => {
    expect(normalizeCronJobPrecheck(null)).toBeUndefined();
    expect(normalizeCronJobPrecheck({})).toBeUndefined();
    expect(normalizeCronJobPrecheck({ command: " exit 2 " })).toEqual({
      kind: "exec",
      command: "exit 2",
    });
  });

  it("rejects present-but-invalid timeoutMs instead of coercing defaults", () => {
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: 0 })).toThrow(
      /timeoutMs must be a positive integer/,
    );
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: -5 })).toThrow(
      /timeoutMs must be a positive integer/,
    );
    expect(() =>
      normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: "fast" as unknown as number }),
    ).toThrow(/timeoutMs must be a positive integer/);
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", timeoutMs: 1.5 })).toThrow(
      /timeoutMs must be a positive integer/,
    );
  });

  it("rejects malformed exit-code lists instead of dropping bad entries", () => {
    expect(() =>
      normalizeCronJobPrecheck({
        command: "echo hi",
        workExitCodes: [0, "x" as unknown as number],
      }),
    ).toThrow(/workExitCodes must contain only finite numbers/);
    expect(() => normalizeCronJobPrecheck({ command: "echo hi", noWorkExitCodes: [] })).toThrow(
      /noWorkExitCodes must be a non-empty array/,
    );
  });
});

const AUTH_FULL = {
  triggersEnabled: true,
  security: "full" as const,
  securityOverrideOnly: true,
};

describe("authorizeCronJobPrecheckCommand", () => {
  it("denies when triggers are disabled", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: { triggersEnabled: false, security: "full", securityOverrideOnly: true },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("cron.triggers.enabled=true");
    }
  });

  it("denies when exec security is deny", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: { triggersEnabled: true, security: "deny", securityOverrideOnly: true },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
      expect(result.reason).toMatch(/security=deny/i);
    }
  });

  it("allows when triggers enabled and security=full", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: AUTH_FULL,
    });
    expect(result).toEqual({ allowed: true });
  });

  it("denies when tools.exec.security=deny even if approvals would default full", async () => {
    // Regression for ClawSweeper P1: config tools.exec must be layered before
    // resolveExecApprovalsLocked (which defaults security=full when no file).
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: {
        triggersEnabled: true,
        // No securityOverrideOnly — exercise live approvals path with config layer.
        toolsExec: { security: "deny" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
      expect(result.reason).toMatch(/security=deny/i);
    }
  });

  it("denies when agent tools.exec.security=deny tightens global full", async () => {
    const result = await authorizeCronJobPrecheckCommand({
      command: "exit 0",
      authz: {
        triggersEnabled: true,
        toolsExec: { security: "full" },
        agentToolsExec: { security: "deny" },
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/security=deny/i);
    }
  });

  it("defaults unconfigured exec policy to allowlist (not full)", async () => {
    // ClawSweeper P1: canonical system.run default is allowlist when tools.exec
    // security is omitted. An empty allowlist must deny arbitrary commands.
    const result = await authorizeCronJobPrecheckCommand({
      command: "echo should-not-run-unconfigured",
      authz: {
        triggersEnabled: true,
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
    }
  });
});

describe("runCronJobPrecheck", () => {
  it("uses fixed trusted shell executables (ignores $SHELL / %ComSpec%)", async () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/tmp/evil-shell-should-not-run";
    let spawned: { cmd: string; args: string[] } | null = null;
    const spawnImpl = ((cmd: string, args: string[]) => {
      spawned = { cmd, args };
      const { EventEmitter } = require("node:events") as typeof import("node:events");
      const child = new EventEmitter() as import("node:events").EventEmitter & {
        stdout: import("node:events").EventEmitter;
        stderr: import("node:events").EventEmitter;
        pid: number;
        kill: () => boolean;
      };
      const mkStream = () => {
        const s = new EventEmitter() as import("node:events").EventEmitter & {
          setEncoding: (enc: string) => void;
        };
        s.setEncoding = () => {};
        return s;
      };
      child.stdout = mkStream();
      child.stderr = mkStream();
      child.pid = 4242;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("ok\n"));
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    try {
      const result = await runCronJobPrecheck(
        { command: "echo ok", contract: "exit-code", workExitCodes: [0], noWorkExitCodes: [2] },
        {
          spawnImpl,
          authz: { triggersEnabled: true, security: "full", securityOverrideOnly: true },
        },
      );
      expect(result.decision).toBe("run");
      expect(spawned).not.toBeNull();
      if (!spawned) {
        throw new Error("expected precheck spawn");
      }
      expect(spawned.cmd).toBe("/bin/sh");
      expect(spawned.args[0]).toBe("-c");
    } finally {
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
    }
  });

  it("blocks host spawn when policy denies (security=deny)", async () => {
    const result = await runCronJobPrecheck(
      { command: "exit 0" },
      {
        authz: { triggersEnabled: true, security: "deny", securityOverrideOnly: true },
      },
    );
    expect(result.decision).toBe("error");
    if (result.decision === "error") {
      expect(result.reason).toContain(PRECHECK_POLICY_DENIED_REASON);
    }
  });

  it("runs a real shell check for exit 2 skip when policy allows", async () => {
    const result = await runCronJobPrecheck({ command: "exit 2" }, { authz: AUTH_FULL });
    expect(result.decision).toBe("skip");
  });

  it("runs a real shell check for exit 0 work when policy allows", async () => {
    const result = await runCronJobPrecheck({ command: "exit 0" }, { authz: AUTH_FULL });
    expect(result.decision).toBe("run");
  });

  it("does not spawn after abort before run", async () => {
    const controller = new AbortController();
    let spawnCount = 0;
    const spawnImpl = ((..._args: unknown[]) => {
      spawnCount += 1;
      throw new Error("spawn should not be called after abort");
    }) as unknown as typeof import("node:child_process").spawn;
    controller.abort();
    const result = await runCronJobPrecheck(
      { command: "echo hi" },
      {
        abortSignal: controller.signal,
        spawnImpl,
        authz: AUTH_FULL,
      },
    );
    expect(result.decision).toBe("error");
    expect(spawnCount).toBe(0);
  });

  it("terminates precheck process tree on timeout", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const marker = path.join(os.tmpdir(), `oc-precheck-tree-${process.pid}-${Date.now()}.pid`);
    // Background sleep should die with process-tree termination, not only the shell root.
    const command = `sleep 600 & echo $! > "${marker}"; wait`;
    const result = await runCronJobPrecheck({ command, timeoutMs: 250 }, { authz: AUTH_FULL });
    expect(result.decision).toBe("error");
    if (result.decision === "error") {
      expect(result.reason).toMatch(/precheck-timeout/);
    }
    await new Promise((r) => setTimeout(r, 400));
    if (fs.existsSync(marker)) {
      const pid = Number(fs.readFileSync(marker, "utf8").trim());
      try {
        fs.unlinkSync(marker);
      } catch {
        // ignore
      }
      if (Number.isFinite(pid) && pid > 0) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    }
  });
});
