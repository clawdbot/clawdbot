import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  isAcpAgentAllowedByPolicy,
  isAcpDispatchEnabledByPolicy,
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
  resolveAcpDispatchPolicyState,
  resolveAcpExplicitTurnPolicyError,
} from "./policy.js";

describe("acp policy", () => {
  it("treats ACP + ACP dispatch as enabled by default", () => {
    const cfg = {} satisfies OpenClawConfig;
    expect(isAcpEnabledByPolicy(cfg)).toBe(true);
    expect(isAcpDispatchEnabledByPolicy(cfg)).toBe(true);
    expect(resolveAcpDispatchPolicyState(cfg)).toBe("enabled");
  });

  it("reports ACP disabled state when acp.enabled is false", () => {
    const cfg = {
      acp: {
        enabled: false,
      },
    } satisfies OpenClawConfig;
    expect(isAcpEnabledByPolicy(cfg)).toBe(false);
    expect(resolveAcpDispatchPolicyState(cfg)).toBe("acp_disabled");
    expect(resolveAcpDispatchPolicyMessage(cfg)).toContain("acp.enabled=false");
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
    expect(isAcpDispatchEnabledByPolicy(cfg)).toBe(false);
    expect(resolveAcpDispatchPolicyState(cfg)).toBe("dispatch_disabled");
    expect(resolveAcpDispatchPolicyMessage(cfg)).toContain("acp.dispatch.enabled=false");
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
    expect(resolveAcpExplicitTurnPolicyError(cfg)?.message).toContain("acp.enabled=false");
  });

  it("applies allowlist filtering for ACP agents", () => {
    const cfg = {
      acp: {
        allowedAgents: ["Codex", "claude-code", "kimi"],
      },
    } satisfies OpenClawConfig;
    expect(isAcpAgentAllowedByPolicy(cfg, "codex")).toBe(true);
    expect(isAcpAgentAllowedByPolicy(cfg, "claude-code")).toBe(true);
    expect(isAcpAgentAllowedByPolicy(cfg, "KIMI")).toBe(true);
    expect(isAcpAgentAllowedByPolicy(cfg, "gemini")).toBe(false);
    expect(resolveAcpAgentPolicyError(cfg, "gemini")?.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(resolveAcpAgentPolicyError(cfg, "codex")).toBeNull();
  });
});
