/**
 * @deprecated Legacy compat surface for plugins that still import
 * openclaw/extension-api. Use the injected plugin runtime or focused
 * openclaw/plugin-sdk subpaths instead.
 */

const shouldWarnExtensionApiImport =
  process.env.VITEST !== "true" &&
  process.env.NODE_ENV !== "test" &&
  process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1";

if (shouldWarnExtensionApiImport) {
  process.emitWarning(
    "openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration",
    {
      code: "OPENCLAW_EXTENSION_API_DEPRECATED",
      detail:
        "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration",
    },
  );
}

export { resolveAgentDir, resolveAgentWorkspaceDir } from "./agents/agent-scope.js";
export { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./agents/defaults.js";
export { resolveAgentIdentity } from "./agents/identity.js";
export { resolveThinkingDefault } from "./agents/model-selection.js";
export { runEmbeddedPiAgent } from "./agents/pi-embedded.js";
export { resolveAgentTimeoutMs } from "./agents/timeout.js";
export { ensureAgentWorkspace } from "./agents/workspace.js";
export {
  resolveStorePath,
  loadSessionStore,
  saveSessionStore,
  resolveSessionFilePath,
} from "./config/sessions.js";
