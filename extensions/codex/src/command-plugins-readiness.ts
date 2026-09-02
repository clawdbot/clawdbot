import {
  renderMessagePresentationFallbackText,
  type MessagePresentation,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import {
  findCodexMarketplacePluginSummary,
  pluginReadParams,
} from "./app-server/plugin-inventory.js";
import type {
  CodexAppsReadResponse,
  CodexExperimentalFeatureListResponse,
} from "./app-server/protocol-control-plane.js";
import { isJsonObject, type CodexAppServerRequestResult, type v2 } from "./app-server/protocol.js";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import { formatCodexAccountLine, formatCodexDisplayText } from "./command-formatters.js";
import {
  buildCodexPluginAppLinks,
  CODEX_PLUGIN_APP_LINK_PAGE_SIZE,
} from "./command-plugin-app-links.js";
import {
  resolveConfiguredPluginIdentity,
  resolveInstalledPluginKey,
  resolveCuratedMarketplaceAliases,
  type CodexPluginsConfigBlock,
} from "./command-plugin-config.js";
import type { CodexPluginCommandContext } from "./command-plugins-runtime.js";
import { discoverCodexMarketplacePlugins } from "./plugin-marketplace-discovery.js";

type Evidence<T> =
  | { status: "known"; value: T }
  | { status: "unavailable"; reason: "unsupported" | "request_failed" };

type CodexHostedAppsSupport =
  | "supported"
  | "sign_in_required"
  | "disabled"
  | "unsupported"
  | "unknown";

export type CodexPluginReadiness = {
  configKey: string;
  commandId: string;
  openClawEnabled: boolean;
  agentId: string;
  profileId?: string;
  workspaceDir: string;
  threadId?: string;
  summary?: v2.PluginSummary;
  detail?: v2.PluginDetail;
  runtime: Evidence<v2.AppsInstalledResponse>;
  metadata: Evidence<CodexAppsReadResponse>;
  account: Evidence<CodexAppServerRequestResult<"account/read">>;
  hostedSupport: CodexHostedAppsSupport;
  diagnostic?: string;
};

/** Runtime support is not account-wide permission to browse, connect or invoke apps. */
async function readCodexHostedAppsSupport(
  context: CodexPluginCommandContext,
  account: CodexPluginReadiness["account"],
): Promise<CodexHostedAppsSupport> {
  if (account.status !== "known") {
    return "unknown";
  }
  if (!isJsonObject(account.value.account) || account.value.account.type !== "chatgpt") {
    return "sign_in_required";
  }
  const features = await readEvidence(async () => {
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const response = await context.request<CodexExperimentalFeatureListResponse>(
        "experimentalFeature/list",
        {
          ...(context.threadId ? { threadId: context.threadId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 100,
        },
      );
      const apps = response.data.find((feature) => feature.name === "apps");
      if (apps) {
        return apps.enabled;
      }
      cursor = response.nextCursor ?? undefined;
      if (cursor && visited.has(cursor)) {
        return undefined;
      }
      if (cursor) {
        visited.add(cursor);
      }
    } while (cursor);
    return undefined;
  });
  if (features.status !== "known") {
    return features.reason === "unsupported" ? "unsupported" : "unknown";
  }
  return features.value === undefined ? "unknown" : features.value ? "supported" : "disabled";
}

function describeCodexHostedAppsSupport(support: CodexHostedAppsSupport): string {
  switch (support) {
    case "supported":
      return "Hosted apps: supported by this runtime; account connections and action permissions are checked separately.";
    case "sign_in_required":
      return "Hosted apps require ChatGPT sign-in. Check /codex account; local Codex plugins remain available.";
    case "disabled":
      return "Hosted apps are disabled in this Codex runtime. Check its effective apps feature configuration.";
    case "unsupported":
      return "Hosted app support is unknown: this Codex version cannot report the required feature state. Update to OpenClaw's supported Codex version.";
    default:
      return "Hosted app support is unknown. Check /codex account and retry this command.";
  }
}

function pluginCatalogState(
  summary: v2.PluginSummary | undefined,
): "available" | "blocked" | "unknown" {
  if (!summary) {
    return "unknown";
  }
  if (summary.availability === "DISABLED_BY_ADMIN" || summary.installPolicy === "NOT_AVAILABLE") {
    return "blocked";
  }
  return summary.availability === "AVAILABLE" &&
    (summary.installPolicy === "AVAILABLE" || summary.installPolicy === "INSTALLED_BY_DEFAULT")
    ? "available"
    : "unknown";
}

export function codexPluginAppPageLinks(readiness: CodexPluginReadiness): v2.AppSummary[] {
  if (
    readiness.hostedSupport !== "supported" ||
    pluginCatalogState(readiness.summary) !== "available" ||
    readiness.metadata.status !== "known"
  ) {
    return [];
  }
  const metadata = new Map(readiness.metadata.value.apps.map((app) => [app.id, app]));
  // app/read omits unknown or unauthorized IDs. plugin/read can manufacture a URL
  // without metadata, so its URL must not substitute for this authorization evidence.
  return (readiness.detail?.apps ?? []).flatMap((app) => {
    const authorized = metadata.get(app.id);
    return authorized ? [{ ...app, name: authorized.name, installUrl: authorized.installUrl }] : [];
  });
}

/** Reads existing snapshots only. Neither metadata nor installation proves a live connection. */
export async function readCodexPluginReadiness(params: {
  context: CodexPluginCommandContext;
  current: CodexPluginsConfigBlock;
  configKey: string;
}): Promise<CodexPluginReadiness> {
  const { context, current, configKey } = params;
  const entry = current.plugins?.[configKey];
  const identity = entry ? resolveConfiguredPluginIdentity(entry) : undefined;
  if (!entry?.marketplaceName || !entry.pluginName || !identity) {
    throw new Error(
      "This configured plugin has no marketplace identity. Check /codex plugins list.",
    );
  }
  const result: CodexPluginReadiness = {
    configKey,
    commandId: `${identity.pluginName}@${identity.marketplaceName}`,
    openClawEnabled: current.enabled === true && entry.enabled !== false,
    agentId: context.agentId,
    profileId: context.profileId,
    workspaceDir: context.workspaceDir,
    threadId: context.threadId,
    runtime: { status: "unavailable", reason: "request_failed" },
    metadata: { status: "unavailable", reason: "request_failed" },
    account: await readEvidence(() =>
      context.request<CodexAppServerRequestResult<"account/read">>("account/read", {
        refreshToken: false,
      }),
    ),
    hostedSupport: "unknown",
  };
  const installed = await readEvidence(() =>
    context.request<v2.PluginInstalledResponse>("plugin/installed", {
      cwds: [context.workspaceDir],
    }),
  );
  let selected =
    installed.status === "known"
      ? findCodexMarketplacePluginSummary(installed.value, entry.marketplaceName, entry.pluginName)
      : undefined;
  if (!selected) {
    const responses: v2.PluginListResponse[] = [];
    const catalog = await readEvidence(() =>
      discoverCodexMarketplacePlugins({
        workspaceDir: context.workspaceDir,
        request: async (requestParams) => {
          const response = await context.request<v2.PluginListResponse>(
            "plugin/list",
            requestParams,
          );
          responses.push(response);
          return response;
        },
      }),
    );
    if (catalog.status === "known") {
      const matches = catalog.value.plugins.filter((plugin) => {
        const configured = resolveInstalledPluginKey(current.plugins ?? {}, plugin);
        return configured.status === "matched" && configured.configKey === configKey;
      });
      const candidate =
        matches.length === 1
          ? matches[0]
          : resolveCuratedMarketplaceAliases(matches, entry.marketplaceName);
      if (candidate) {
        for (const response of responses) {
          selected = findCodexMarketplacePluginSummary(
            response,
            candidate.marketplaceName,
            candidate.summaryId,
          );
          if (selected) {
            selected.summary = {
              ...selected.summary,
              installed: candidate.installed,
              enabled: candidate.enabled,
              ...(candidate.available ? {} : { availability: "DISABLED_BY_ADMIN" }),
            };
            break;
          }
        }
      }
    } else {
      result.diagnostic = describeUnavailableEvidence(catalog.reason);
    }
  }
  if (!selected) {
    await context.validateCurrent();
    return result;
  }
  result.summary = selected.summary;
  const selectedPlugin = selected;
  const pluginName = selected.marketplace.remoteMarketplaceName
    ? selected.summary.remotePluginId
    : entry.pluginName;
  if (!pluginName) {
    return result;
  }
  const detail = await readEvidence(() =>
    context.request<v2.PluginReadResponse>(
      "plugin/read",
      pluginReadParams(selectedPlugin.marketplace, pluginName),
    ),
  );
  if (detail.status !== "known" || detail.value.plugin.summary.id !== selected.summary.id) {
    if (detail.status === "unavailable") {
      result.diagnostic = describeUnavailableEvidence(detail.reason);
    }
    await context.validateCurrent();
    return result;
  }
  result.detail = detail.value.plugin;
  // Installed inventory may be cached. Use the validated detail response's newer
  // policy so a restriction cannot be hidden behind an earlier AVAILABLE record.
  result.summary = detail.value.plugin.summary;
  const appIds = Array.from(new Set(result.detail.apps.map((app) => app.id))).toSorted();
  if (appIds.length > 0) {
    result.hostedSupport = await readCodexHostedAppsSupport(context, result.account);
    // app/read's documented 100-id limit applies independently of presentation pages.
    const [runtime, metadata] = await Promise.all([
      readEvidence(() =>
        context.request<v2.AppsInstalledResponse>("app/installed", {
          ...(context.threadId ? { threadId: context.threadId } : {}),
          forceRefresh: false,
        }),
      ),
      readEvidence(async () => {
        const responses: CodexAppsReadResponse[] = [];
        for (let offset = 0; offset < appIds.length; offset += 100) {
          responses.push(
            await context.request<CodexAppsReadResponse>("app/read", {
              appIds: appIds.slice(offset, offset + 100),
              ...(context.threadId ? { threadId: context.threadId } : {}),
            }),
          );
        }
        return {
          apps: responses.flatMap((response) => response.apps),
          missingAppIds: responses.flatMap((response) => response.missingAppIds),
        };
      }),
    ]);
    result.runtime = runtime;
    result.metadata = metadata;
  }
  await context.validateCurrent();
  return result;
}

export function formatCodexPluginReadiness(
  readiness: CodexPluginReadiness,
  page = 1,
): PluginCommandResult {
  const summary = readiness.summary;
  const catalog = pluginCatalogState(summary);
  const hasApps = Boolean(readiness.detail?.apps.length);
  const lines = [
    `Plugin: ${display(readiness.commandId)}`,
    `Agent: ${display(readiness.agentId)} · Profile: ${display(readiness.profileId ?? "native Codex account (profile unknown)")}`,
    `Conversation workspace: ${display(readiness.workspaceDir)}`,
    formatBoundAccount(readiness.account),
    `Catalog: ${catalog === "blocked" ? "blocked by marketplace policy" : catalog}`,
    `Bundle: ${summary ? (summary.installed ? "installed" : "not installed") : "unknown"}`,
    `Codex plugin: ${summary ? (summary.enabled ? "enabled" : "disabled") : "unknown"}`,
    `OpenClaw app access: ${readiness.openClawEnabled ? "enabled for new conversations" : "disabled for new conversations"} (shared Codex plugin configuration).`,
    ...(hasApps
      ? [
          describeCodexHostedAppsSupport(readiness.hostedSupport),
          "Connection: unknown. Codex does not report live account-link status in these reads.",
        ]
      : []),
  ];
  if (catalog === "blocked") {
    lines.push(
      summary?.disabledReason === "plan_not_eligible"
        ? "Next: this ChatGPT plan is not eligible for the plugin. Check its plan requirements."
        : summary?.disabledReason === "required_app_unavailable"
          ? "Next: a required hosted app is unavailable. Check access with the app or workspace owner."
          : summary?.disabledReason === "disabled_by_admin" ||
              summary?.availability === "DISABLED_BY_ADMIN"
            ? "Next: ask the marketplace administrator to restore access."
            : "Next: check the plugin's marketplace requirements; its policy does not permit installation.",
    );
  } else if (!readiness.openClawEnabled) {
    lines.push(`Next: /codex plugins enable ${readiness.commandId}, then /new or /reset.`);
  } else if (summary && (!summary.installed || !summary.enabled)) {
    lines.push(`Next: /codex plugins install ${readiness.commandId}, then /new or /reset.`);
  }
  const blocks: MessagePresentationBlock[] = [{ type: "text", text: lines.join("\n") }];
  if (readiness.diagnostic) {
    blocks.push({ type: "text", text: readiness.diagnostic });
  }
  if (!readiness.detail) {
    blocks.push({
      type: "text",
      text: "App details unavailable. Check the plugin in Codex, then run this status command again.",
    });
  } else {
    const apps = readiness.detail.apps.toSorted((left, right) => left.id.localeCompare(right.id));
    const pageCount = Math.max(1, Math.ceil(apps.length / CODEX_PLUGIN_APP_LINK_PAGE_SIZE));
    if (page > pageCount) {
      return {
        text: `No app page ${page}. Use /codex plugins status ${readiness.commandId} ${pageCount}.`,
      };
    }
    const start = (page - 1) * CODEX_PLUGIN_APP_LINK_PAGE_SIZE;
    const visible = apps.slice(start, start + CODEX_PLUGIN_APP_LINK_PAGE_SIZE);
    const runtimeById = new Map(
      readiness.runtime.status === "known"
        ? readiness.runtime.value.apps.map((app) => [app.id, app])
        : [],
    );
    if (visible.length > 0 && readiness.runtime.status === "unavailable") {
      blocks.push({ type: "text", text: describeUnavailableEvidence(readiness.runtime.reason) });
    }
    blocks.push({
      type: "text",
      text:
        visible.length === 0
          ? "No hosted apps declared. Skills and other plugin capabilities are not assessed here."
          : [
              `Apps (page ${page}/${pageCount}):`,
              ...visible.map((app) => {
                const runtime = runtimeById.get(app.id);
                const state = !runtime
                  ? "unknown: absent or unavailable runtime snapshot"
                  : !runtime.enabled
                    ? "disabled by effective Codex app policy"
                    : !runtime.callable
                      ? "not callable in the runtime snapshot"
                      : readiness.threadId
                        ? "callable in this thread's runtime snapshot"
                        : "available in account runtime snapshot; current-thread callability unknown";
                return `- ${display(app.name)}: ${state}.`;
              }),
            ].join("\n"),
    });
    if (visible.length > 0) {
      const authorized = new Map(codexPluginAppPageLinks(readiness).map((app) => [app.id, app]));
      const links = visible.flatMap((app) => {
        const link = authorized.get(app.id);
        return link ? [link] : [];
      });
      blocks.push(
        ...buildCodexPluginAppLinks(
          links,
          page < pageCount
            ? {
                continuationCommand: `/codex plugins status ${readiness.commandId} ${page + 1}`,
              }
            : {},
        ),
      );
      if (links.length < visible.length) {
        blocks.push({
          type: "text",
          text: "Some app-page permissions are unknown or unavailable. A declared app or setup URL does not establish access. Retry this status command after checking the reported restriction.",
        });
      }
      blocks.push({
        type: "text",
        text: "Snapshot freshness is unknown; this read does not refresh hosted tools or verify a live call. Browser setup does not change OpenClaw app access. Use /new or /reset after setup or local permission changes; existing conversations keep their admitted app policy.",
      });
    }
  }
  const presentation: MessagePresentation = { title: "Codex plugin status", blocks };
  return {
    text: renderMessagePresentationFallbackText({ presentation }),
    presentation,
    presentationTextMode: "fallback",
  };
}

async function readEvidence<T>(read: () => Promise<T>): Promise<Evidence<T>> {
  try {
    return { status: "known", value: await read() };
  } catch (error) {
    // Do not forward provider error bodies, URLs, or account identifiers to chat.
    return {
      status: "unavailable",
      reason:
        error instanceof CodexAppServerRpcError && error.code === -32601
          ? "unsupported"
          : "request_failed",
    };
  }
}

function describeUnavailableEvidence(reason: "unsupported" | "request_failed"): string {
  return reason === "unsupported"
    ? "This Codex app-server does not support the required status method. Update to OpenClaw's supported Codex version."
    : "Codex status could not be read. Check Codex sign-in and connectivity, then run this command again.";
}

function display(value: string): string {
  return formatCodexDisplayText(value.slice(0, 120));
}

function formatBoundAccount(evidence: CodexPluginReadiness["account"]): string {
  const account = evidence.status === "known" ? evidence.value.account : undefined;
  if (isJsonObject(account) && account.type === "chatgpt") {
    const email = typeof account.email === "string" ? account.email : "email unknown";
    const plan = typeof account.planType === "string" ? account.planType : "plan unknown";
    return `ChatGPT account: ${formatCodexAccountLine(email.slice(0, 120))} (${display(plan)}).`;
  }
  if (isJsonObject(account) && typeof account.type === "string") {
    return `Account type: ${display(account.type)}; ChatGPT account identity is not available.`;
  }
  return "Codex account: unknown. Check /codex account.";
}
