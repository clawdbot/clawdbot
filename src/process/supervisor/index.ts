// Process supervisor barrel exposes the supervised process API.
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ProcessSupervisor } from "./types.js";

const holder = resolveGlobalSingleton(
  Symbol.for("openclaw.processSupervisorHolder"),
  (): { current: ReturnType<typeof createProcessSupervisor> | null } => ({ current: null }),
  async (value) => {
    const supervisor = value.current;
    await supervisor?.shutdown();
    if (value.current === supervisor) {
      value.current = null;
    }
  },
);

/** Return the process-wide supervisor used by runtime code that does not inject one. */
export function getProcessSupervisor(): ProcessSupervisor {
  if (holder.current) {
    return holder.current;
  }
  holder.current = createProcessSupervisor();
  return holder.current;
}

export type { ManagedRun, ProcessSupervisor } from "./types.js";
