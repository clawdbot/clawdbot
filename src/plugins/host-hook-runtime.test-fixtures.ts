/** Test-only inspection of process-global plugin host runtime state. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
} from "./host-hooks.js";

export const PLUGIN_TERMINAL_EVENT_CLEANUP_WAIT_MS = 5_000;

type SchedulerJobRecord = {
  job: PluginSessionSchedulerJobRegistration;
};

type PluginHostRuntimeState = {
  schedulerJobsByPlugin: Map<string, Map<string, SchedulerJobRecord>>;
};

export function listPluginSessionSchedulerJobs(
  pluginId?: string,
): PluginSessionSchedulerJobHandle[] {
  const state = resolveGlobalSingleton<PluginHostRuntimeState>(
    Symbol.for("openclaw.pluginHostRuntimeState"),
    () => ({ schedulerJobsByPlugin: new Map() }),
  );
  const records: PluginSessionSchedulerJobHandle[] = [];
  const pluginIds = pluginId ? [pluginId] : [...state.schedulerJobsByPlugin.keys()];
  for (const currentPluginId of pluginIds) {
    const jobs = state.schedulerJobsByPlugin.get(currentPluginId);
    if (!jobs) {
      continue;
    }
    for (const record of jobs.values()) {
      records.push({
        id: record.job.id,
        pluginId: currentPluginId,
        sessionKey: record.job.sessionKey,
        kind: record.job.kind,
      });
    }
  }
  return records.toSorted((left, right) => left.id.localeCompare(right.id));
}
