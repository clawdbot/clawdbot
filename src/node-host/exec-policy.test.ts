import { describe, expect, it } from "vitest";
import {
  evaluateSystemRunPolicy,
  formatSystemRunAllowlistMissMessage,
  resolveExecApprovalDecision,
} from "./exec-policy.js";

type EvaluatePolicyParams = Parameters<typeof evaluateSystemRunPolicy>[0];
type EvaluatePolicyDecision = ReturnType<typeof evaluateSystemRunPolicy>;

const buildPolicyParams = (overrides: Partial<EvaluatePolicyParams>): EvaluatePolicyParams => {
  return {
    security: "allowlist",
    ask: "off",
    analysisOk: true,
    allowlistSatisfied: true,
    approvalDecision: null,
    approved: false,
    isWindows: false,
    cmdInvocation: false,
    shellWrapperInvocation: false,
    ...overrides,
  };
};

const expectDeniedDecision = (decision: EvaluatePolicyDecision) => {
  expect(decision.allowed).toBe(false);
  if (decision.allowed) {
    throw new Error("expected denied decision");
  }
  return decision;
};

const expectAllowedDecision = (decision: EvaluatePolicyDecision) => {
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) {
    throw new Error("expected allowed decision");
  }
  return decision;
};

describe("resolveExecApprovalDecision", () => {
  it("accepts known approval decisions", () => {
    expect(resolveExecApprovalDecision("allow-once")).toBe("allow-once");
    expect(resolveExecApprovalDecision("allow-always")).toBe("allow-always");
  });

  it("normalizes unknown approval decisions to null", () => {
    expect(resolveExecApprovalDecision("deny")).toBeNull();
    expect(resolveExecApprovalDecision(undefined)).toBeNull();
  });
});

describe("formatSystemRunAllowlistMissMessage", () => {
  it("returns legacy allowlist miss message by default", () => {
    expect(formatSystemRunAllowlistMissMessage()).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("adds shell-wrapper guidance when wrappers are blocked", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        shellWrapperBlocked: true,
      }),
    ).toContain("shell wrappers like sh/bash/zsh -c require approval");
  });

  it("adds Windows shell-wrapper guidance when blocked by cmd.exe policy", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        shellWrapperBlocked: true,
        windowsShellWrapperBlocked: true,
      }),
    ).toContain("Windows shell wrappers like cmd.exe /c require approval");
  });
});

describe("evaluateSystemRunPolicy", () => {
  it("denies when security mode is deny", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(buildPolicyParams({ security: "deny" })),
    );
    expect(denied.eventReason).toBe("security=deny");
    expect(denied.errorMessage).toBe("SYSTEM_RUN_DISABLED: security=deny");
  });

  it("requires approval when ask policy requires it", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(buildPolicyParams({ ask: "always" })),
    );
    expect(denied.eventReason).toBe("approval-required");
    expect(denied.requiresAsk).toBe(true);
  });

  it("still requires approval when ask=always even with durable trust", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({
          security: "full",
          ask: "always",
          durableApprovalSatisfied: true,
        }),
      ),
    );
    expect(denied.eventReason).toBe("approval-required");
    expect(denied.requiresAsk).toBe(true);
  });

  it("allows allowlist miss when explicit approval is provided", () => {
    const allowed = expectAllowedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({
          ask: "on-miss",
          analysisOk: false,
          allowlistSatisfied: false,
          approvalDecision: "allow-once",
        }),
      ),
    );
    expect(allowed.approvedByAsk).toBe(true);
  });

  it("denies allowlist misses without approval", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(buildPolicyParams({ analysisOk: false, allowlistSatisfied: false })),
    );
    expect(denied.eventReason).toBe("allowlist-miss");
    expect(denied.errorMessage).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("keeps POSIX shell wrapper decisions tied to allowlist analysis", () => {
    const allowed = expectAllowedDecision(
      evaluateSystemRunPolicy(buildPolicyParams({ shellWrapperInvocation: true })),
    );
    expect(allowed.shellWrapperBlocked).toBe(false);
    expect(allowed.analysisOk).toBe(true);
    expect(allowed.allowlistSatisfied).toBe(true);
  });

  it("keeps Windows-specific guidance for cmd.exe wrappers", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({ isWindows: true, cmdInvocation: true, shellWrapperInvocation: true }),
      ),
    );
    expect(denied.shellWrapperBlocked).toBe(true);
    expect(denied.windowsShellWrapperBlocked).toBe(true);
    expect(denied.errorMessage).toContain("Windows shell wrappers like cmd.exe /c");
  });

  it("does not block Windows cmd.exe invocations without inline shell-wrapper transport", () => {
    const allowed = expectAllowedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({ isWindows: true, cmdInvocation: true, shellWrapperInvocation: false }),
      ),
    );
    expect(allowed.shellWrapperBlocked).toBe(false);
    expect(allowed.windowsShellWrapperBlocked).toBe(false);
  });

  it("allows execution when policy checks pass", () => {
    const allowed = expectAllowedDecision(
      evaluateSystemRunPolicy(buildPolicyParams({ ask: "on-miss" })),
    );
    expect(allowed.requiresAsk).toBe(false);
    expect(allowed.analysisOk).toBe(true);
    expect(allowed.allowlistSatisfied).toBe(true);
  });
});
