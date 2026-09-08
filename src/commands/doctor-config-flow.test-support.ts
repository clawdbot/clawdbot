import { vi } from "vitest";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";

export async function prepareDoctorContext(configPath: string): Promise<DoctorHealthFlowContext> {
  const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const options: DoctorOptions = { nonInteractive: true, repair: true };
  const prompter = createDoctorPrompter({ runtime, options });
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (params) => prompter.confirm(params),
    runtime,
    prompter,
  });
  return {
    runtime,
    options,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath,
    stateDirExistedAtStart: true,
    runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
    invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
  };
}
