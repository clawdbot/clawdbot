/**
 * Claude extension entry point. Registers the claude-bridge AgentHarness
 * for the `anthropic` provider so OpenClaw can delegate Claude turns to a
 * local @zeroaltitude/openclaw-claude-bridge process (the Anthropic analog of the
 * codex-app-server pattern).
 *
 * The harness factory itself lives in harness.ts; runtime is in
 * src/app-server/run-attempt.ts and is dynamic-imported to keep the entry
 * point lazy.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClaudeAppServerAgentHarness } from "./harness.js";
import { registerClaudeSessionsPanel } from "./src/app-server/sessions-panel.js";
import type { ClaudeAppServerBindingStore } from "./src/app-server/thread-store.js";
import { createClaudeCommand } from "./src/commands.js";

export default definePluginEntry({
  id: "claude",
  name: "Claude",
  description:
    "Claude app-server harness — delegates Anthropic turns to @zeroaltitude/openclaw-claude-bridge.",
  register(api) {
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "claude",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;
    // One shared, promise-memoized store: /claude resume|thread-pop must
    // serialize through the SAME lifecycle-lock queue instance the harness
    // uses, or a command write can interleave with an in-flight turn's
    // read-classify-write and be silently clobbered.
    let bindingStorePromise: Promise<ClaudeAppServerBindingStore> | undefined;
    const resolveBindingStore = (): Promise<ClaudeAppServerBindingStore> =>
      (bindingStorePromise ??= import("./src/app-server/thread-store.js").then((m) =>
        m.openClaudeAppServerBindingStore(api.runtime),
      ));
    api.registerAgentHarness(
      createClaudeAppServerAgentHarness({
        resolvePluginConfig: resolveCurrentPluginConfig,
        resolveBindingStore,
      }),
    );
    api.registerCommand(
      createClaudeCommand({
        pluginConfig: api.pluginConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
        resolveBindingStore,
      }),
    );
    registerClaudeSessionsPanel(api);
  },
});
