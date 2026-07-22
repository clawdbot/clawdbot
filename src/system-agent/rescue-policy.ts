// OpenClaw rescue policy gates remote writes by owner, DM, sandbox, and YOLO posture.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecModePolicy } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Policy checks for remote OpenClaw rescue commands.
 *
 * Rescue intentionally opens only for owner-controlled, non-sandboxed YOLO host
 * posture because remote commands can write local state.
 */
type SystemAgentRescueDecision =
  | {
      allowed: true;
      enabled: true;
      ownerDmOnly: boolean;
      pendingTtlMinutes: number;
      yolo: true;
      sandboxActive: false;
    }
  | {
      allowed: false;
      enabled: boolean;
      ownerDmOnly: boolean;
      pendingTtlMinutes: number;
      yolo: boolean;
      sandboxActive: boolean;
      reason: "disabled" | "sandbox-active" | "not-owner" | "not-direct-message";
      message: string;
    };

type SystemAgentRescuePolicyInput = {
  cfg: OpenClawConfig;
  agentId?: string;
  senderIsOwner: boolean;
  isDirectMessage: boolean;
};

function resolveAgentEntry(cfg: OpenClawConfig, agentId?: string) {
  if (!agentId) {
    return undefined;
  }
  const id = normalizeAgentId(agentId);
  return cfg.agents?.list?.find(
    (entry) => entry !== null && typeof entry === "object" && normalizeAgentId(entry.id) === id,
  );
}

function resolveScopedExecConfig(cfg: OpenClawConfig, agentId?: string) {
  return resolveAgentEntry(cfg, agentId)?.tools?.exec;
}

function resolveScopedSandboxMode(
  cfg: OpenClawConfig,
  agentId?: string,
): "off" | "non-main" | "all" {
  return (
    resolveAgentEntry(cfg, agentId)?.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode ?? "off"
  );
}

function isYoloHostPosture(cfg: OpenClawConfig, agentId?: string): boolean {
  const scopedExec = resolveScopedExecConfig(cfg, agentId);
  const globalExec = cfg.tools?.exec;
  const inherited = resolveExecModePolicy({
    mode: globalExec?.mode,
    security: globalExec?.security ?? "full",
    ask: globalExec?.ask ?? "off",
  });
  return (
    resolveExecModePolicy({
      mode: scopedExec?.mode,
      security: scopedExec?.security ?? inherited.security,
      ask: scopedExec?.ask ?? inherited.ask,
    }).mode === "full"
  );
}

/** Decide whether a message-channel rescue command is allowed for this sender/context. */
export function resolveSystemAgentRescuePolicy(
  input: SystemAgentRescuePolicyInput,
): SystemAgentRescueDecision {
  const ownerDmOnly = true;
  const pendingTtlMinutes = 15;
  const sandboxActive = resolveScopedSandboxMode(input.cfg, input.agentId) !== "off";
  const yolo = !sandboxActive && isYoloHostPosture(input.cfg, input.agentId);
  const enabled = yolo;

  if (sandboxActive) {
    return {
      allowed: false,
      enabled,
      ownerDmOnly,
      pendingTtlMinutes,
      yolo,
      sandboxActive,
      reason: "sandbox-active",
      message:
        "OpenClaw rescue is blocked because OpenClaw sandboxing is active. Fix the install locally or disable sandboxing before using remote rescue.",
    };
  }
  if (!enabled) {
    return {
      allowed: false,
      enabled,
      ownerDmOnly,
      pendingTtlMinutes,
      yolo,
      sandboxActive,
      reason: "disabled",
      message: "OpenClaw rescue requires YOLO host posture with sandboxing off.",
    };
  }
  if (!input.senderIsOwner) {
    return {
      allowed: false,
      enabled,
      ownerDmOnly,
      pendingTtlMinutes,
      yolo,
      sandboxActive,
      reason: "not-owner",
      message: "OpenClaw rescue only accepts commands from an OpenClaw owner.",
    };
  }
  if (ownerDmOnly && !input.isDirectMessage) {
    return {
      allowed: false,
      enabled,
      ownerDmOnly,
      pendingTtlMinutes,
      yolo,
      sandboxActive,
      reason: "not-direct-message",
      message: "OpenClaw rescue is restricted to owner DMs by default.",
    };
  }
  return {
    allowed: true,
    enabled: true,
    ownerDmOnly,
    pendingTtlMinutes,
    yolo: true,
    sandboxActive: false,
  };
}
