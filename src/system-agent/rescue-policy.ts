// OpenClaw rescue policy gates remote writes by owner, DM, sandbox, and YOLO posture.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Policy checks for remote OpenClaw rescue commands.
 *
 * Rescue intentionally opens only for owner-controlled, non-sandboxed YOLO host
 * posture unless config explicitly enables it, because remote commands can write local state.
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
      reason: "disabled" | "sandbox-active" | "not-yolo" | "not-owner" | "not-direct-message";
      message: string;
    };

type SystemAgentRescuePolicyInput = {
  cfg: OpenClawConfig;
  agentId?: string;
  senderIsOwner: boolean;
  isDirectMessage: boolean;
};

function resolvePendingTtlMinutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 15;
}

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
  const security = scopedExec?.security ?? globalExec?.security ?? "full";
  const ask = scopedExec?.ask ?? globalExec?.ask ?? "off";
  return security === "full" && ask === "off";
}

/** Decide whether a message-channel rescue command is allowed for this sender/context. */
export function resolveSystemAgentRescuePolicy(
  input: SystemAgentRescuePolicyInput,
): SystemAgentRescueDecision {
  const rescue = input.cfg.systemAgent?.rescue;
  const configuredEnabled = rescue?.enabled ?? "auto";
  const ownerDmOnly = rescue?.ownerDmOnly ?? true;
  const pendingTtlMinutes = resolvePendingTtlMinutes(rescue?.pendingTtlMinutes);
  const sandboxActive = resolveScopedSandboxMode(input.cfg, input.agentId) !== "off";
  const yolo = !sandboxActive && isYoloHostPosture(input.cfg, input.agentId);
  // "auto" means rescue follows host posture; explicit false/true still keeps owner/DM gates.
  const enabled = configuredEnabled === "auto" ? yolo : configuredEnabled;

  if (!enabled) {
    return {
      allowed: false,
      enabled,
      ownerDmOnly,
      pendingTtlMinutes,
      yolo,
      sandboxActive,
      reason: "disabled",
      message:
        "OpenClaw rescue is disabled. Set systemAgent.rescue.enabled=true or use YOLO host posture with sandboxing off.",
    };
  }
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
  if (configuredEnabled === "auto" && !yolo) {
    return {
      allowed: false,
      enabled,
      ownerDmOnly,
      pendingTtlMinutes,
      yolo,
      sandboxActive,
      reason: "not-yolo",
      message:
        "OpenClaw rescue auto-mode only opens in YOLO host posture: tools.exec.security=full, tools.exec.ask=off, and sandboxing off.",
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
