import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import type { CodexPluginsConfigBlock, CodexPluginsManagementIO } from "./command-plugin-config.js";
import type { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";

export type CodexPluginsManagementRuntime = NonNullable<
  Parameters<typeof handleCodexPluginsSubcommand>[3]
>;

export function pluginSummary(
  name: string,
  marketplace: string,
  overrides: Partial<v2.PluginSummary> = {},
) {
  return {
    id: `${name}@${marketplace}`,
    name,
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    availability: "AVAILABLE",
    authPolicy: "ON_USE",
    ...(overrides.remotePluginId ? { mustShowInstallationInterstitial: false } : {}),
    interface: { shortDescription: "Security review <@team> *instructions*" },
    ...overrides,
  } satisfies v2.PluginSummary;
}

export function pluginRuntime(params?: {
  marketplace?: string;
  marketplacePath?: string;
  pluginName?: string;
  remotePluginId?: string;
  mustShowInstallationInterstitial?: boolean | null;
  installed?: boolean;
  enabled?: boolean;
  install?: CodexPluginsManagementRuntime["install"];
  refresh?: CodexPluginsManagementRuntime["refresh"];
  setupAllowed?: boolean;
}) {
  const marketplace = params?.marketplace ?? "company-tools";
  const pluginName = params?.pluginName ?? "security-review";
  const summary = pluginSummary(pluginName, marketplace, {
    ...(params?.remotePluginId
      ? {
          remotePluginId: params.remotePluginId,
          ...(params.mustShowInstallationInterstitial !== undefined
            ? {
                mustShowInstallationInterstitial: params.mustShowInstallationInterstitial,
              }
            : {}),
        }
      : {}),
    ...(params?.installed ? { installed: true } : {}),
    ...(params?.enabled ? { enabled: true } : {}),
  });
  const listed = {
    marketplaces: [
      {
        name: marketplace,
        ...(params?.marketplacePath ? { path: params.marketplacePath } : {}),
        plugins: [summary],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  } satisfies v2.PluginListResponse;
  let pendingApps: v2.AppSummary[] = [];
  const install =
    params?.install ?? vi.fn(async () => ({ authPolicy: "ON_USE", appsNeedingAuth: [] }));
  return {
    workspaceDir: vi.fn(async () => "/repo/company"),
    list: vi.fn(async () => listed),
    install: vi.fn(async (request: v2.PluginInstallParams) => {
      const response = await install(request);
      pendingApps = response.appsNeedingAuth;
      return response;
    }),
    withContext: async <T>(run: (context: CodexPluginCommandContext) => Promise<T>): Promise<T> =>
      run({
        workspaceDir: "/repo/company",
        agentId: "test",
        appCacheKey: "test",
        validateCurrent: async () => {},
        current: {
          enabled: true,
          plugins: {
            [`${pluginName}@${marketplace}`]: {
              enabled: true,
              marketplaceName: marketplace,
              pluginName,
            },
          },
        },
        request: async <TResponse>(method: string): Promise<TResponse> => {
          const responses: Record<string, unknown> = {
            "account/read": { account: { type: "chatgpt" } },
            "experimentalFeature/list": {
              data: [{ name: "apps", enabled: true }],
              nextCursor: null,
            },
            "plugin/installed": listed,
            "plugin/read": {
              plugin: {
                summary,
                apps: pendingApps,
                mcpServers: [],
              },
            },
            "app/installed": { apps: [] },
            "app/read": {
              apps: params?.setupAllowed === false ? [] : pendingApps,
              missingAppIds: params?.setupAllowed === false ? pendingApps.map((app) => app.id) : [],
            },
          };
          if (!(method in responses)) {
            throw new Error(`Unexpected setup method: ${method}`);
          }
          return responses[method] as TResponse;
        },
      }),
    ...(params?.refresh ? { refresh: params.refresh } : {}),
  } satisfies CodexPluginsManagementRuntime;
}

type CodexPluginConfigEntry = NonNullable<CodexPluginsConfigBlock["plugins"]>[string];

export function inMemoryIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
  options: { enabled?: boolean } = { enabled: true },
): CodexPluginsManagementIO & {
  current: () => Record<string, CodexPluginConfigEntry>;
  currentConfig: () => CodexPluginsConfigBlock;
} {
  const store: CodexPluginsConfigBlock = {
    enabled: options.enabled,
    plugins: structuredClone(initial),
  };
  return {
    current: () => structuredClone(store.plugins ?? {}),
    currentConfig: () => structuredClone(store),
    readConfig: () => Promise.resolve(structuredClone(store)),
    mutate: async (update) => {
      update(store);
    },
  };
}

export const fakeCtx: PluginCommandContext = {
  args: "",
  config: {},
  channel: "test",
  isAuthorizedSender: true,
  senderIsOwner: true,
  commandBody: "/codex plugins",
  requestConversationBinding: async () => ({ status: "error", message: "unused" }),
  detachConversationBinding: async () => ({ removed: false }),
  getCurrentConversationBinding: async () => null,
};

function presentationButtons(result: PluginCommandResult) {
  return (result.presentation?.blocks ?? []).flatMap((block) =>
    block.type === "buttons" ? block.buttons : [],
  );
}

export function buttonCommands(result: PluginCommandResult): string[] {
  return presentationButtons(result).flatMap((button) =>
    button.action?.type === "command" ? [button.action.command] : [],
  );
}
