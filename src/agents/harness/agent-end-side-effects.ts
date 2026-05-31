import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runSkillResearchAutoCapture } from "../../skills/research/autocapture.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

async function runCoreAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  try {
    await runSkillResearchAutoCapture({
      event: params.event,
      ctx: params.ctx,
      ...(params.ctx.config ? { config: params.ctx.config } : {}),
    });
  } catch (error) {
    log.warn(`skill research auto-capture failed: ${String(error)}`);
  }
}

export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  void runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook(params);
}

export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  await runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook(params);
}
