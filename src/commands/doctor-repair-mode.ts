import { isTruthyEnvValue } from "../infra/env.js";
import type { DoctorOptions } from "./doctor.types.js";

export type DoctorRepairMode = {
  shouldRepair: boolean;
  shouldForce: boolean;
  nonInteractive: boolean;
  canPrompt: boolean;
  updateInProgress: boolean;
};

export function resolveDoctorRepairMode(options: DoctorOptions): DoctorRepairMode {
  const yes = options.yes === true;
  const requestedNonInteractive = options.nonInteractive === true;
  const shouldRepair = options.repair === true || yes;
  const shouldForce = options.force === true;
  const isTty = process.stdin.isTTY;
  const nonInteractive = requestedNonInteractive || (!isTty && !yes);
  const updateInProgress = isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS);
  const canPrompt = isTty && !yes && !nonInteractive;

  return {
    shouldRepair,
    shouldForce,
    nonInteractive,
    canPrompt,
    updateInProgress,
  };
}

export function isDoctorUpdateRepairMode(mode: DoctorRepairMode): boolean {
  return mode.updateInProgress && mode.nonInteractive;
}

export function shouldAutoApproveDoctorFix(
  mode: DoctorRepairMode,
  params: {
    requiresForce?: boolean;
    blockDuringUpdate?: boolean;
  } = {},
): boolean {
  if (!mode.shouldRepair) {
    return false;
  }
  if (params.requiresForce && !mode.shouldForce) {
    return false;
  }
  if (params.blockDuringUpdate && isDoctorUpdateRepairMode(mode)) {
    return false;
  }
  return true;
}
