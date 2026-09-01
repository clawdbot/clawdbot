/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 *
 * Run via: node --import tsx src/mcp/plugin-tools-serve.ts
 * Or: bun src/mcp/plugin-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveManifestToolProfileNames } from "../agents/conversation-capability-profile.js";
import {
  hasModelSpecificProviderToolPolicy,
  resolveProviderToolPolicy,
} from "../agents/provider-tool-policy.js";
import { resolveRequesterToolPolicies } from "../agents/requester-tool-policy.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  type ToolPolicyPipelineStep,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { routeLogsToStderr } from "../logging/console.js";
import { loadManifestContractSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataManifestView } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderRefOwnership } from "../plugins/providers.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { ensureStandalonePluginToolRegistryLoaded, resolvePluginTools } from "../plugins/tools.js";
import {
  parseToolsMcpModelRef,
  resolveToolsMcpAgentId,
  resolveToolsMcpModelRef,
  resolveToolsMcpSessionContext,
} from "./agent-session-env.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

function isKnownModelProvider(params: {
  config: OpenClawConfig;
  provider: string | undefined;
}): boolean {
  const provider = normalizeProviderId(params.provider ?? "");
  if (!provider) {
    return false;
  }
  return Boolean(
    findNormalizedProviderValue(params.config.models?.providers, provider) ||
    resolveProviderRefOwnership({ provider, config: params.config }).status !== "unowned",
  );
}

function resolvePluginToolPolicy(params: {
  config: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
  pluginMetadataSnapshot?: PluginMetadataManifestView;
}): {
  toolAllowlist?: string[];
  toolDenylist?: string[];
  steps?: ToolPolicyPipelineStep[];
} {
  if (!params.agentId) {
    const profilePolicy = mergeAlsoAllowPolicy(
      resolveToolProfilePolicy(params.config.tools?.profile),
      [
        ...resolveManifestToolProfileNames(
          params.pluginMetadataSnapshot,
          params.config.tools?.profile,
        ),
        ...(params.config.tools?.alsoAllow ?? []),
      ],
    );
    const globalPolicy = pickSandboxToolPolicy(params.config.tools);
    const providerPolicy = resolveProviderToolPolicy({
      byProvider: params.config.tools?.byProvider,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    });
    const providerProfile = providerPolicy?.profile;
    const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
      ...resolveManifestToolProfileNames(params.pluginMetadataSnapshot, providerProfile),
      ...(providerPolicy?.alsoAllow ?? []),
    ]);
    const globalProviderPolicy = pickSandboxToolPolicy(providerPolicy);
    const providerPolicyConfigured = Object.keys(params.config.tools?.byProvider ?? {}).length > 0;
    const providerIdentityKnown = isKnownModelProvider({
      config: params.config,
      provider: params.modelProvider,
    });
    const unknownProviderPolicy =
      providerPolicyConfigured &&
      (!providerIdentityKnown ||
        (!params.modelId &&
          hasModelSpecificProviderToolPolicy({
            byProvider: params.config.tools?.byProvider,
            modelProvider: params.modelProvider,
          })))
        ? { deny: ["*"] }
        : undefined;
    if (unknownProviderPolicy) {
      logWarn(
        "plugin tools disabled: provider-specific tool policy requires recognized ACP provider/model identity; start a fresh session with a configured provider and model",
      );
    }
    const policies = [
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      unknownProviderPolicy,
    ];
    const toolAllowlist = collectExplicitAllowlist(policies);
    const toolDenylist = collectExplicitDenylist(policies);
    return {
      ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
      ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
      steps: buildDefaultToolPolicyPipelineSteps({
        profilePolicy,
        profile: params.config.tools?.profile,
        providerProfilePolicy,
        providerProfile,
        globalPolicy,
        globalProviderPolicy,
      })
        .concat({ policy: unknownProviderPolicy, label: "unknown ACP provider" })
        .map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true })),
    };
  }
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profile = effective.profile;
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [
    ...resolveManifestToolProfileNames(params.pluginMetadataSnapshot, profile),
    ...(effective.profileAlsoAllow ?? []),
  ]);
  const providerProfile = effective.providerProfile;
  const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
    ...resolveManifestToolProfileNames(params.pluginMetadataSnapshot, providerProfile),
    ...(effective.providerProfileAlsoAllow ?? []),
  ]);
  const globalPolicy = effective.globalPolicy;
  const globalProviderPolicy = effective.globalProviderPolicy;
  const agentPolicy = effective.agentPolicy;
  const agentProviderPolicy = effective.agentProviderPolicy;
  const providerIdentityKnown = isKnownModelProvider({
    config: params.config,
    provider: params.modelProvider,
  });
  const unknownProviderPolicy =
    effective.providerPolicyConfigured &&
    (!providerIdentityKnown ||
      (!params.modelId && effective.unresolvedModelProviderPolicyConfigured))
      ? { deny: ["*"] }
      : undefined;
  if (unknownProviderPolicy) {
    logWarn(
      "plugin tools disabled: provider-specific tool policy requires recognized ACP provider/model identity; start a fresh session with a configured provider and model",
    );
  }
  const { subagentPolicy, inheritedToolPolicy } = resolveRequesterToolPolicies({
    config: params.config,
    agentId: effective.agentId,
    sessionKey: params.sessionKey,
    subagentSessionKey: params.sessionKey,
    senderPolicyMode: "never",
  });
  const policies = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    unknownProviderPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ];
  const toolAllowlist = collectExplicitAllowlist(policies);
  const toolDenylist = collectExplicitDenylist(policies);
  return {
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy,
        profile,
        providerProfilePolicy,
        providerProfile,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        agentId: effective.agentId,
      }),
      { policy: unknownProviderPolicy, label: "unknown ACP provider" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ].map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true })),
  };
}

export function resolvePluginToolsForMcp(params: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  modelRef?: string;
}): AnyAgentTool[] {
  const sessionContext = resolveToolsMcpSessionContext(params);
  const model = parseToolsMcpModelRef(params.modelRef ?? resolveToolsMcpModelRef());
  const pluginMetadataSnapshot = loadManifestContractSnapshot({ config: params.config });
  const context = { config: params.config, ...sessionContext };
  const { steps, ...pluginToolPolicy } = resolvePluginToolPolicy({
    config: params.config,
    ...sessionContext,
    ...(model ? { modelProvider: model.provider, modelId: model.modelId } : {}),
    pluginMetadataSnapshot,
  });
  const runtimeRegistry = ensureStandalonePluginToolRegistryLoaded({
    context,
    ...pluginToolPolicy,
  });
  const tools = resolvePluginTools({
    context,
    ...pluginToolPolicy,
    suppressNameConflicts: true,
    runtimeRegistry,
  });
  // Flattened policy lists only bound discovery; layered allowlists must still intersect.
  return steps
    ? applyToolPolicyPipeline({
        tools,
        toolMeta: getPluginToolMeta,
        warn: logWarn,
        steps,
      })
    : tools;
}

export function createPluginToolsMcpServer(
  params: {
    config?: OpenClawConfig;
    tools?: AnyAgentTool[];
    agentSessionKey?: string;
    agentId?: string;
  } = {},
): Server {
  const cfg = params.config ?? getRuntimeConfig();
  const tools =
    params.tools ??
    resolvePluginToolsForMcp({
      config: cfg,
      agentSessionKey: params.agentSessionKey,
      agentId: params.agentId,
    });
  return createToolsMcpServer({ name: "openclaw-plugin-tools", tools });
}

export async function servePluginToolsMcp(): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only, including during plugin
  // tool discovery before the transport is connected.
  routeLogsToStderr();

  const config = getRuntimeConfig();
  const tools = resolvePluginToolsForMcp({ config, agentId: resolveToolsMcpAgentId() });
  const server = createPluginToolsMcpServer({ config, tools });
  if (tools.length === 0) {
    process.stderr.write("plugin-tools-serve: no plugin tools found\n");
  }

  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  servePluginToolsMcp().catch((err: unknown) => {
    process.stderr.write(`plugin-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
