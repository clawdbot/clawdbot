import { confirm, select } from "@clack/prompts";

import type { RuntimeEnv } from "../runtime.js";
import { guardCancel } from "./onboard-helpers.js";

export type DoctorOptions = {
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
};

export type DoctorPrompter = {
  confirm: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
  confirmSkipInNonInteractive: (
    params: Parameters<typeof confirm>[0],
  ) => Promise<boolean>;
  select: <T>(params: Parameters<typeof select>[0], fallback: T) => Promise<T>;
};

export function createDoctorPrompter(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
}): DoctorPrompter {
  const yes = params.options.yes === true;
  const requestedNonInteractive = params.options.nonInteractive === true;
  const isTty = Boolean(process.stdin.isTTY);
  const nonInteractive = requestedNonInteractive || (!isTty && !yes);

  const canPrompt = isTty && !yes && !nonInteractive;
  const confirmDefault = async (p: Parameters<typeof confirm>[0]) => {
    if (!canPrompt) return Boolean(p.initialValue ?? false);
    return guardCancel(await confirm(p), params.runtime) === true;
  };

  return {
    confirm: confirmDefault,
    confirmSkipInNonInteractive: async (p) => {
      if (nonInteractive) return false;
      return confirmDefault(p);
    },
    select: async <T>(p: Parameters<typeof select>[0], fallback: T) => {
      if (!canPrompt) return fallback;
      return guardCancel(await select(p), params.runtime) as T;
    },
  };
}
