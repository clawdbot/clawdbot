import { openClawAgentCoreRuntime } from "../../runtime/index.js";
import type { SessionModelUsageSink } from "../session-model-usage.js";

export type { SessionModelUsageSink } from "../session-model-usage.js";

/** Adds a private usage sink without changing public summary result shapes. */
export function createCompactionRuntime(usageSink?: SessionModelUsageSink) {
  return usageSink
    ? { ...openClawAgentCoreRuntime, internalUsageSink: usageSink }
    : openClawAgentCoreRuntime;
}
