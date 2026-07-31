// Public library facade for consumers embedding OpenClaw reply runtime APIs.
import type { getReplyFromConfig as getReplyFromConfigRuntime } from "./auto-reply/reply.runtime.js";
import { applyTemplate } from "./auto-reply/templating.js";
import { createDefaultDeps } from "./cli/deps.js";
import type { promptYesNo as promptYesNoRuntime } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import { resolveStorePath } from "./config/sessions/paths.js";
import { deriveSessionKey, resolveSessionKey } from "./config/sessions/session-key.js";
import type { ensureBinary as ensureBinaryRuntime } from "./infra/binaries.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import {
  loadLegacySessionStore,
  saveLegacySessionStore,
  type LegacySessionStoreLoadOptions,
  type LegacySessionStoreSaveOptions,
} from "./infra/state-migrations.legacy-session-store.js";
import type { monitorWebChannel as monitorWebChannelRuntime } from "./plugins/runtime/runtime-web-channel-plugin.js";
import type {
  runCommandWithTimeout as runCommandWithTimeoutRuntime,
  runExec as runExecRuntime,
} from "./process/exec.js";
import { createLazyRuntimeModule } from "./shared/lazy-runtime.js";
import { normalizeE164 } from "./utils.js";

type GetReplyFromConfig = typeof getReplyFromConfigRuntime;
type PromptYesNo = typeof promptYesNoRuntime;
type EnsureBinary = typeof ensureBinaryRuntime;
type RunExec = typeof runExecRuntime;
type RunCommandWithTimeout = typeof runCommandWithTimeoutRuntime;
type MonitorWebChannel = typeof monitorWebChannelRuntime;

const loadReplyRuntime = createLazyRuntimeModule(() => import("./auto-reply/reply.runtime.js"));
const loadPromptRuntime = createLazyRuntimeModule(() => import("./cli/prompt.js"));
const loadBinariesRuntime = createLazyRuntimeModule(() => import("./infra/binaries.js"));
const loadExecRuntime = createLazyRuntimeModule(() => import("./process/exec.js"));
const loadWebChannelRuntime = createLazyRuntimeModule(
  () => import("./plugins/runtime/runtime-web-channel-plugin.js"),
);

export const getReplyFromConfig: GetReplyFromConfig = async (...args) =>
  (await loadReplyRuntime()).getReplyFromConfig(...args);
export const promptYesNo: PromptYesNo = async (...args) =>
  (await loadPromptRuntime()).promptYesNo(...args);
export const ensureBinary: EnsureBinary = async (...args) =>
  (await loadBinariesRuntime()).ensureBinary(...args);
export const runExec: RunExec = async (...args) => (await loadExecRuntime()).runExec(...args);
export const runCommandWithTimeout: RunCommandWithTimeout = async (...args) =>
  (await loadExecRuntime()).runCommandWithTimeout(...args);
export const monitorWebChannel: MonitorWebChannel = async (...args) =>
  (await loadWebChannelRuntime()).monitorWebChannel(...args);

/**
 * @deprecated Legacy sessions.json compatibility for package-root consumers.
 * Use SQLite-backed session APIs. Remove after 2026-10-12, once the v2026.7.x
 * upgrade window no longer requires the legacy doctor importer.
 */
export function loadSessionStore(storePath: string, options?: LegacySessionStoreLoadOptions) {
  return loadLegacySessionStore(storePath, options);
}

/**
 * @deprecated Legacy sessions.json compatibility for package-root consumers.
 * Use SQLite-backed session APIs. Remove after 2026-10-12, once the v2026.7.x
 * upgrade window no longer requires the legacy doctor importer.
 */
export async function saveSessionStore(
  storePath: string,
  store: Parameters<typeof saveLegacySessionStore>[1],
  options?: LegacySessionStoreSaveOptions,
): Promise<void> {
  await saveLegacySessionStore(storePath, store, options);
}

export {
  applyTemplate,
  createDefaultDeps,
  deriveSessionKey,
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  loadConfig,
  normalizeE164,
  PortInUseError,
  resolveSessionKey,
  resolveStorePath,
  waitForever,
};
