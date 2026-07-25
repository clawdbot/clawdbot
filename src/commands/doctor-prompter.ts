/** Doctor prompt adapter that centralizes repair, force, update, and noninteractive behavior. */
import { confirm, select } from "@clack/prompts";
import { styleSelectParams } from "../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../packages/terminal-core/src/prompt-style.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveDoctorRepairMode,
  shouldAutoApproveDoctorFix,
  type DoctorRepairMode,
} from "./doctor-repair-mode.js";
import type { DoctorOptions } from "./doctor.types.js";
import { guardCancel } from "./onboard-helpers.js";

export type { DoctorOptions } from "./doctor.types.js";

type DoctorConfirmParams = Parameters<typeof confirm>[0];
type DoctorRuntimeRepairConfirmParams = DoctorConfirmParams & {
  requiresInteractiveConfirmation?: boolean;
};

export type DoctorPrompter = {
  confirm: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmAutoFix: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmAggressiveAutoFix: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmRuntimeRepair: (params: DoctorRuntimeRepairConfirmParams) => Promise<boolean>;
  select: <T>(params: Parameters<typeof select>[0], fallback: T) => Promise<T>;
  shouldRepair: boolean;
  shouldForce: boolean;
  repairMode: DoctorRepairMode;
};

/** Creates a doctor prompter honoring --fix, --yes, --force, noninteractive, and update modes. */
export function createDoctorPrompter(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
}): DoctorPrompter {
  const repairMode = resolveDoctorRepairMode(params.options);
  const confirmDefault = async (p: Parameters<typeof confirm>[0]) => {
    if (shouldAutoApproveDoctorFix(repairMode)) {
      return true;
    }
    if (repairMode.nonInteractive) {
      return false;
    }
    if (!repairMode.canPrompt) {
      return p.initialValue ?? false;
    }
    // Exit 130 (SIGINT convention) so the installer can distinguish
    // user cancellation from normal doctor failures.
    return guardCancel(
      await confirm({
        ...p,
        message: stylePromptMessage(p.message),
      }),
      params.runtime,
      130,
    );
  };

  return {
    confirm: confirmDefault,
    confirmAutoFix: confirmDefault,
    confirmAggressiveAutoFix: async (p) => {
      if (shouldAutoApproveDoctorFix(repairMode, { requiresForce: true })) {
        return true;
      }
      if (repairMode.nonInteractive) {
        return false;
      }
      if (repairMode.shouldRepair && !repairMode.shouldForce) {
        return false;
      }
      if (!repairMode.canPrompt) {
        return p.initialValue ?? false;
      }
      return guardCancel(
        await confirm({
          ...p,
          message: stylePromptMessage(p.message),
        }),
        params.runtime,
        130,
      );
    },
    confirmRuntimeRepair: async (p) => {
      const { requiresInteractiveConfirmation, ...confirmParams } = p;
      if (
        requiresInteractiveConfirmation !== true &&
        shouldAutoApproveDoctorFix(repairMode, { blockDuringUpdate: true })
      ) {
        return true;
      }
      if (requiresInteractiveConfirmation === true && !repairMode.canPrompt) {
        return false;
      }
      if (repairMode.nonInteractive) {
        return false;
      }
      if (!repairMode.canPrompt) {
        return confirmParams.initialValue ?? false;
      }
      return guardCancel(
        await confirm({
          ...confirmParams,
          message: stylePromptMessage(confirmParams.message),
        }),
        params.runtime,
        130,
      );
    },
    select: async <T>(p: Parameters<typeof select>[0], fallback: T) => {
      if (!repairMode.canPrompt || repairMode.shouldRepair) {
        return fallback;
      }
      return guardCancel(await select(styleSelectParams(p)), params.runtime, 130) as T;
    },
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}
