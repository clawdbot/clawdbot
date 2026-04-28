import { confirm, select } from "@clack/prompts";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../terminal/prompt-style.js";
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
    return guardCancel(
      await confirm({
        ...p,
        message: stylePromptMessage(p.message),
      }),
      params.runtime,
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
      );
    },
    select: async <T>(p: Parameters<typeof select>[0], fallback: T) => {
      if (!repairMode.canPrompt || repairMode.shouldRepair) {
        return fallback;
      }
      return guardCancel(
        await select({
          ...p,
          message: stylePromptMessage(p.message),
          options: p.options.map((opt) =>
            opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
          ),
        }),
        params.runtime,
      ) as T;
    },
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}
