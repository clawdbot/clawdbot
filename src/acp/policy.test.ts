/** Tests ACP policy gates for enablement, dispatch, and allowed agents. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
  resolveAcpExplicitTurnPolicyError,
} from "./policy.js";

describe("acp policy", () => {
  it("treats ACP + ACP dispatch as enabled by default", () => {
    const cfg = {} satisfies OpenClawConfig;
    expect(isAcpEnabledByPolicy(cfg)).toBe(true);
    expect(resolveAcpDispatchPolicyMessage(cfg)).toBeNull();
    expect(resolveAcpDispatchPolicyError(cfg)).toBeNull();
  });

  it("reports ACP disabled state when acp.enabled is false", () => {
    const cfg = {
      acp: {
        enabled: false,
      },
    } satisfies OpenClawConfig;
    expect(isAcpEnabledByPolicy(cfg)).toBe(false);
    expect(resolveAcpDispatchPolicyMessage(cfg)).toBe(
      "ACP is disabled by policy (`acp.enabled=false`).",
    );
    expect(resolveAcpDispatchPolicyError(cfg)?.code).toBe("ACP_DISPATCH_DISABLED");
  });

  it("reports dispatch-disabled state when dispatch gate is false", () => {
    const cfg = {
      acp: {
        enabled: true,
        dispatch: {
          enabled: false,
        },
      },
    } satisfies OpenClawConfig;
    expect(resolveAcpDispatchPolicyMessage(cfg)).toBe(
      "ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`).",
    );
  });

  it("allows explicit ACP turns when only dispatch is disabled", () => {
    const cfg = {
      acp: {
        enabled: true,
        dispatch: {
          enabled: false,
        },
      },
    } satisfies OpenClawConfig;
    expect(resolveAcpDispatchPolicyError(cfg)?.code).toBe("ACP_DISPATCH_DISABLED");
    expect(resolveAcpExplicitTurnPolicyError(cfg)).toBeNull();
  });

  it("blocks explicit ACP turns when ACP is disabled", () => {
    const cfg = {
      acp: {
        enabled: false,
        dispatch: {
          enabled: false,
        },
      },
    } satisfies OpenClawConfig;
    expect(resolveAcpExplicitTurnPolicyError(cfg)?.message).toBe(
      "ACP is disabled by policy (`acp.enabled=false`).",
    );
  });

  it("applies allowlist filtering for ACP agents", () => {
    const cfg = {
      acp: {
        allowedAgents: ["Codex", "claude-code", "kimi"],
      },
    } satisfies OpenClawConfig;
    expect(resolveAcpAgentPolicyError(cfg, "codex")).toBeNull();
    expect(resolveAcpAgentPolicyError(cfg, "claude-code")).toBeNull();
    expect(resolveAcpAgentPolicyError(cfg, "KIMI")).toBeNull();
    expect(resolveAcpAgentPolicyError(cfg, "gemini")?.code).toBe("ACP_SESSION_INIT_FAILED");
  });
});
