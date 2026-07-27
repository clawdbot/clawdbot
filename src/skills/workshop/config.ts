// Workshop config helpers resolve skill workshop settings from OpenClaw config.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Runtime configuration for the skill workshop proposal flow. */
export type SkillWorkshopConfig = {
  autonomous: {
    enabled: boolean;
  };
  allowSymlinkTargetWrites: boolean;
  approvalPolicy: "pending" | "auto";
  maxPending: number;
  maxSkillBytes: number;
};

const DEFAULT_CONFIG: SkillWorkshopConfig = {
  autonomous: {
    enabled: false,
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

function readApprovalPolicy(value: unknown, fallback: SkillWorkshopConfig["approvalPolicy"]) {
  return value === "pending" || value === "auto" ? value : fallback;
}

export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = asNullableRecord(config?.skills?.workshop) ?? {};
  const autonomous = asNullableRecord(raw.autonomous) ?? {};
  return {
    autonomous: {
      enabled: readBoolean(autonomous.enabled, DEFAULT_CONFIG.autonomous.enabled),
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
