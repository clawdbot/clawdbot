import { describe, expect, it } from "vitest";
import {
  PRECHECK_NO_WORK_REASON,
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
    expect(
      interpretPrecheckOutput({
        exitCode: 7,
        stdout: "",
        stderr: "boom",
        onError: "skip",
      }).decision,
    ).toBe("skip");
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
});

describe("normalizeCronJobPrecheck", () => {
  it("requires a command and normalizes kinds", () => {
    expect(normalizeCronJobPrecheck(null)).toBeUndefined();
    expect(normalizeCronJobPrecheck({})).toBeUndefined();
    expect(normalizeCronJobPrecheck({ command: " exit 2 " })).toEqual({
      kind: "exec",
      command: "exit 2",
    });
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
});

describe("runCronJobPrecheck", () => {
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
});
