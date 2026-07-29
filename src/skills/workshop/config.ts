// Workshop config helpers resolve skill workshop settings from OpenClaw config.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillsWorkshopAutonomousMode } from "../../config/types.skills.js";

/** Runtime configuration for the skill workshop proposal flow. */
type SkillWorkshopConfig = {
  autonomous: {
    mode: SkillsWorkshopAutonomousMode;
  };
  allowSymlinkTargetWrites: boolean;
  approvalPolicy: "pending" | "auto";
  maxPending: number;
  maxSkillBytes: number;
};

const DEFAULT_CONFIG: SkillWorkshopConfig = {
  autonomous: {
    mode: "auto",
  },
  allowSymlinkTargetWrites: false,
  approvalPolicy: "auto",
  maxPending: 50,
  maxSkillBytes: 40_000,
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
}

function readAutonomousMode(
  value: unknown,
  fallback: SkillsWorkshopAutonomousMode,
): SkillsWorkshopAutonomousMode {
  return value === "off" || value === "propose" || value === "auto" ? value : fallback;
}

function readApprovalPolicy(value: unknown, fallback: SkillWorkshopConfig["approvalPolicy"]) {
  return value === "pending" || value === "auto" ? value : fallback;
}

export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = asNullableRecord(config?.skills?.workshop) ?? {};
  const autonomous = asNullableRecord(raw.autonomous) ?? {};
  return {
    autonomous: {
      mode: readAutonomousMode(autonomous.mode, DEFAULT_CONFIG.autonomous.mode),
    },
    allowSymlinkTargetWrites: readBoolean(
      raw.allowSymlinkTargetWrites,
      DEFAULT_CONFIG.allowSymlinkTargetWrites,
    ),
    approvalPolicy: readApprovalPolicy(raw.approvalPolicy, DEFAULT_CONFIG.approvalPolicy),
    maxPending: readInteger(raw.maxPending, DEFAULT_CONFIG.maxPending, 1, 200),
    maxSkillBytes: readInteger(raw.maxSkillBytes, DEFAULT_CONFIG.maxSkillBytes, 1024, 200_000),
  };
}
