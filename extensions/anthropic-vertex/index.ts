import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { NATIVE_ANTHROPIC_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  mergeImplicitAnthropicVertexProvider,
  resolveAnthropicVertexConfigApiKey,
  resolveImplicitAnthropicVertexProvider,
} from "./api.js";

const PROVIDER_ID = "anthropic-vertex";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Anthropic Vertex Provider",
  description: "Bundled Anthropic Vertex provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Anthropic Vertex",
      docsPath: "/providers/models",
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const implicit = resolveImplicitAnthropicVertexProvider({
            env: ctx.env,
          });
          if (!implicit) {
            return null;
          }
          return {
            provider: mergeImplicitAnthropicVertexProvider({
              existing: ctx.config.models?.providers?.[PROVIDER_ID],
              implicit,
            }),
          };
        },
      },
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
      ...NATIVE_ANTHROPIC_REPLAY_HOOKS,
    });
  },
});
