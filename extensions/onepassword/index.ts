import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveLivePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AuditRow, PendingAuthorization, StandingGrant } from "./src/broker.js";
import { OnePasswordBroker } from "./src/broker.js";
import { MAX_REGISTERED_ITEMS, parseOnePasswordConfig } from "./src/config.js";
import { OpClient } from "./src/op-client.js";
import { createOnePasswordTool, redactPersistedOnePasswordResult } from "./src/tool.js";

const MAX_AUDIT_ROWS = 40_000;
const MAX_STANDING_GRANTS = MAX_REGISTERED_ITEMS * 32;

export default definePluginEntry({
  id: "onepassword",
  name: "1Password",
  description: "Curated 1Password secrets broker with approval policy and SQLite audit history.",
  register(api) {
    const startupConfig = parseOnePasswordConfig(api.pluginConfig);
    const resolveCurrentConfig = () => {
      const liveConfig = api.runtime.config?.current
        ? (api.runtime.config.current() as OpenClawConfig)
        : undefined;
      if (!liveConfig) {
        return startupConfig;
      }
      const livePluginConfig = resolveLivePluginConfigObject(
        () => liveConfig,
        "onepassword",
        api.pluginConfig as Record<string, unknown> | undefined,
      );
      const enabled = resolveEffectiveEnableState({
        id: "onepassword",
        origin: "bundled",
        config: normalizePluginsConfig(liveConfig.plugins),
        rootConfig: liveConfig,
        enabledByDefault: livePluginConfig !== undefined,
      }).enabled;
      return enabled ? parseOnePasswordConfig(livePluginConfig) : undefined;
    };
    const grants = api.runtime.state.openKeyedStore<StandingGrant>({
      namespace: "grants",
      // Evicting the oldest grant is fail-closed: that agent must approve again.
      // Keep enough room for 32 agents holding every registered slug.
      maxEntries: MAX_STANDING_GRANTS,
      overflowPolicy: "evict-oldest",
    });
    const audit = api.runtime.state.openKeyedStore<AuditRow>({
      namespace: "audit",
      maxEntries: MAX_AUDIT_ROWS,
      overflowPolicy: "evict-oldest",
    });
    const pending = api.runtime.state.openSyncKeyedStore<PendingAuthorization>({
      namespace: "pending",
      maxEntries: 512,
      overflowPolicy: "evict-oldest",
    });
    const tokenFile = path.join(
      api.runtime.state.resolveStateDir(process.env),
      "credentials",
      "onepassword",
      "service-account-token",
    );
    let cachedOpClient: { key: string; client: OpClient } | undefined;
    const resolveCurrentOpClient = () => {
      const config = resolveCurrentConfig();
      const key = JSON.stringify([config?.opBin ?? null, config?.opTimeoutMs ?? 15_000]);
      if (cachedOpClient?.key === key) {
        return cachedOpClient.client;
      }
      const client = new OpClient({
        opBin: config?.opBin,
        tokenFile,
        timeoutMs: config?.opTimeoutMs ?? 15_000,
        warn: (message) => api.logger.warn(message),
      });
      cachedOpClient = { key, client };
      return client;
    };
    const broker = startupConfig
      ? new OnePasswordBroker({
          resolveConfig: resolveCurrentConfig,
          opClient: {
            getItem: (params) => resolveCurrentOpClient().getItem(params),
          },
          stores: { audit, grants, pending },
        })
      : undefined;

    api.registerCli(
      async ({ program }) => {
        const { registerOnePasswordCommands } = await import("./src/cli.js");
        registerOnePasswordCommands({
          program,
          resolveConfig: resolveCurrentConfig,
          resolveOpClient: resolveCurrentOpClient,
          auditStore: audit,
        });
      },
      {
        descriptors: [
          {
            name: "onepassword",
            description: "Inspect the 1Password secrets broker",
            hasSubcommands: true,
          },
        ],
      },
    );

    if (!broker) {
      return;
    }
    api.registerTool((context) => createOnePasswordTool(broker, context), {
      name: "onepassword",
    });
    api.on("before_tool_call", (event, ctx) => broker.beforeToolCall(event, ctx));
    api.on("tool_result_persist", redactPersistedOnePasswordResult);
  },
});
