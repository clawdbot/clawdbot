import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { DiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore } from "./store.js";

type DiscordActivityWidget = NonNullable<Awaited<ReturnType<DiscordActivityStore["lookupWidget"]>>>;
type DiscordActivitySession = NonNullable<
  Awaited<ReturnType<DiscordActivityStore["lookupSession"]>>
>;
type DiscordActivityDocToken = NonNullable<
  Awaited<ReturnType<DiscordActivityStore["consumeDocToken"]>>
>;
type DiscordActivityPendingLaunch =
  | NonNullable<Awaited<ReturnType<DiscordActivityStore["consumePendingLaunch"]>>>
  | { state: "ambiguous"; createdAt: number };
type DiscordActivityStores = ConstructorParameters<typeof DiscordActivityStore>[0];

export function createMemoryKeyedStore<T>(): PluginStateKeyedStore<T> & {
  update: NonNullable<PluginStateKeyedStore<T>["update"]>;
} {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        return values.delete(key);
      }
      values.set(key, { key, value: next, createdAt: values.get(key)?.createdAt ?? Date.now() });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

export function createMemoryActivityStore(): DiscordActivityStore {
  const stores: DiscordActivityStores = {
    widgets: createMemoryKeyedStore<DiscordActivityWidget>(),
    sessions: createMemoryKeyedStore<DiscordActivitySession>(),
    docTokens: createMemoryKeyedStore<DiscordActivityDocToken>(),
    launches: createMemoryKeyedStore<DiscordActivityPendingLaunch>(),
  };
  return new DiscordActivityStore(stores);
}

export function createActivityTestConfig(params?: {
  userId?: string;
  clientSecret?: string;
  applicationId?: string;
}): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "testtok",
        allowFrom: [params?.userId ?? "42"],
        activities: {
          ...(params?.clientSecret === undefined
            ? { clientSecret: "testsec" }
            : params.clientSecret
              ? { clientSecret: params.clientSecret }
              : {}),
          applicationId: params?.applicationId ?? "123456789012345678",
        },
      },
    },
  };
}

export function createActivityTestRuntime(
  cfg = createActivityTestConfig(),
  env: NodeJS.ProcessEnv = {},
): DiscordActivitiesRuntime {
  return new DiscordActivitiesRuntime(createMemoryActivityStore(), cfg, undefined, env);
}
