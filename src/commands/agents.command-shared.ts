// Shared config-loading helpers for agent management commands.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  requireValidConfigFileSnapshot as requireValidConfigFileSnapshotBase,
  requireValidConfigSnapshot,
} from "./config-validation.js";

/** Wrap a runtime so helper setup work stays silent in JSON output paths. */
export function createQuietRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return { ...runtime, log: () => {} };
}

/** Load a config file snapshot and surface validation errors through the runtime. */
export async function requireValidConfigFileSnapshot(runtime: RuntimeEnv) {
  return await requireValidConfigFileSnapshotBase(runtime);
}

/** Load the current runtime config and return null after reporting validation failures. */
export async function requireValidConfig(runtime: RuntimeEnv): Promise<OpenClawConfig | null> {
  return await requireValidConfigSnapshot(runtime);
}
