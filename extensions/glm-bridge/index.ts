/**
 * GLM bridge extension entry point. Registers a SECOND, independent
 * claude-bridge-shaped AgentHarness for the `zai` provider, reusing
 * createClaudeAppServerAgentHarness (extensions/claude/harness.ts) —
 * the SAME unmodified @zeroaltitude/openclaw-claude-bridge process the Claude
 * extension uses, just pointed at Z.ai's Anthropic-compatible endpoint.
 *
 * No bridge-package fork, no duplicated run-attempt/thread-lifecycle logic:
 * createClaudeAppServerAgentHarness is already a generic factory (id, label,
 * providerIds, resolvePluginConfig), and the shared client pool
 * (extensions/claude/src/app-server/client.ts) already keys on caller-supplied
 * pool keys derived from `appServer.modelProvider`, so this extension's turns
 * run in their own concurrently-alive bridge process without disturbing the
 * Claude extension's (openclaw-7ss).
 *
 * This is a same-monorepo relative import, not a published-package import —
 * extensions/claude and extensions/glm-bridge are both compiled under the one
 * unified extensions TypeScript project (tsconfig.extensions.json), so this
 * needs no separate boundary-dts build step (that machinery — see
 * scripts/prepare-extension-package-boundary-artifacts.mjs — is for
 * EXTERNAL, out-of-repo plugin consumers, not internal same-repo extensions).
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeAppServerAgentHarness } from "../claude/harness.js";

/** Z.ai's Anthropic-compatible Messages API endpoint. */
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

/**
 * Merge GLM-specific defaults (provider identity, Z.ai base URL) UNDER
 * whatever the operator explicitly configured for this plugin, so a bare
 * install works with just an API key while still letting every field be
 * overridden (e.g. to point at a different Anthropic-compatible endpoint).
 *
 * Exported for unit coverage of the merge contract (openclaw-6mt).
 */
export function applyGlmDefaults(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = (config ?? {}) as { appServer?: Record<string, unknown> };
  const appServer = base.appServer ?? {};
  const env = (appServer.env ?? {}) as Record<string, string>;
  return {
    ...base,
    appServer: {
      modelProvider: "zai",
      ...appServer,
      env: {
        ANTHROPIC_BASE_URL: DEFAULT_ZAI_BASE_URL,
        ...env,
      },
    },
  };
}

export default definePluginEntry({
  id: "glm-bridge",
  name: "GLM Bridge",
  description:
    "GLM app-server harness — delegates Z.ai-provider turns to @zeroaltitude/openclaw-claude-bridge pointed at Z.ai's Anthropic-compatible endpoint.",
  register(api) {
    const resolveCurrentPluginConfig = () => {
      const resolved =
        resolveLivePluginConfigObject(
          api.runtime.config?.current
            ? () => api.runtime.config.current() as OpenClawConfig
            : undefined,
          "glm-bridge",
          api.pluginConfig as Record<string, unknown>,
        ) ?? (api.pluginConfig as Record<string, unknown> | undefined);
      return applyGlmDefaults(resolved);
    };
    api.registerAgentHarness(
      createClaudeAppServerAgentHarness({
        id: "glm-bridge",
        label: "GLM app-server harness (via Z.ai)",
        providerIds: ["zai"],
        resolvePluginConfig: resolveCurrentPluginConfig,
        // Bindings land in glm-bridge's own plugin-state namespace, separate
        // from the claude extension's — a session runs on one harness at a
        // time, and cross-provider thread resume was never valid anyway.
        // Follow-up: /claude threads|resume|thread-pop|conversations read the
        // claude plugin's namespace only, so GLM sessions need a /glm command
        // (same handlers, this store, zai pool key) to regain that surface.
        runtime: api.runtime,
      }),
    );
  },
});
