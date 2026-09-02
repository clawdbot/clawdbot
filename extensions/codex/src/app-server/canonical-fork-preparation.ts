import { randomUUID } from "node:crypto";
import {
  loadCodexBundleMcpThreadConfig,
  type AgentHarnessSessionForkParams,
  type AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  resolveCodexMcpToolOverridesForAgent,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { buildNativeHookRelayCommandPlan } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { prepareCodexWorkspaceDeveloperInstructions } from "./attempt-context.js";
import { resolveOpenClawExecPolicyForCodexAppServer } from "./config-exec-policy.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer.js";
import { readCodexPluginConfig, resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { resolveCodexNativeExecutionPolicy } from "./native-execution-policy.js";
import {
  assertCodexNativeHookRelayAllowed,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayId,
  resolveCodexNativeHookRelayEvents,
} from "./native-hook-relay.js";
import {
  applyCodexNativeSkillIsolation,
  resolveCodexNativeSkillIsolation,
} from "./native-skill-isolation.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";
import {
  buildCodexPluginThreadConfig,
  mergeCodexThreadConfigs,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { isJsonObject, type CodexDynamicToolSpec } from "./protocol.js";
import { resolveCodexProviderWebSearchSupportForClient } from "./provider-capabilities.js";
import { readCodexAppServerClientDesktopGenerationFingerprint } from "./shared-client.js";
import { isCodexDynamicToolExcluded } from "./shell-dynamic-tools.js";
import {
  fingerprintJsonObject,
  fingerprintUserMcpServersConfigPatch,
} from "./thread-fingerprints.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import { buildCodexThreadConfiguration } from "./thread-requests.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

type Created = Awaited<ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>>;
type Initialization = NonNullable<AgentHarnessSessionDeletionParams["initialization"]>;

/** Creation preserves native declarations; admitted turns own all live executors. */
export async function prepareCanonicalCodexFork(params: {
  created: Created;
  initialization: Initialization;
  config: OpenClawConfig;
  context: NonNullable<CodexSessionCatalogControl["forkContext"]>;
  model: string;
  modelProvider: string;
  sandbox: AgentHarnessSessionForkParams["sandbox"];
  dynamicTools: CodexDynamicToolSpec[];
}) {
  const { created, initialization, config, context } = params;
  const assertCurrent = initialization.assertCurrent;
  assertCurrent();
  if (!initialization.prepareNativeToolPolicy) {
    throw new Error(
      "Canonical Codex forks require host native tool policy preparation. Update the Gateway before retrying.",
    );
  }
  const workspaceDir = resolveAgentWorkspaceDir(config, created.agentId);
  const cwd = created.entry.spawnedCwd ?? workspaceDir;
  const execution = resolveCodexNativeExecutionPolicy({
    config,
    agentId: created.agentId,
    sessionKey: created.key,
    sessionEntry: created.entry,
  });
  if (
    params.sandbox === "required" ||
    !execution.nativeToolSurfaceAllowed ||
    execution.effectiveExecHost !== "gateway" ||
    context.appServer.remoteWorkspaceRoot
  ) {
    throw new Error(
      "This child requires an execution environment that cannot be prepared during a native fork. Fork an original imported message instead.",
    );
  }
  const pluginConfig = readCodexPluginConfig(context.pluginConfig);
  const runtime = resolveCodexSupervisionAppServerRuntimeOptions({
    pluginConfig,
    config,
    agentDir: context.agentDir,
    model: params.model,
    modelProvider: params.modelProvider,
    execPolicy: resolveOpenClawExecPolicyForCodexAppServer({
      config,
      agentId: created.agentId,
      approvals: loadExecApprovals(),
    }),
  });
  // Creation cannot provision a role-required environment. For supported local
  // children, the catalog owns the connection and run policy owns permissions.
  const appServer = { ...runtime, start: context.appServer.start };
  const { webSearchAllowed: hostWebSearchAllowed } = await initialization.prepareNativeToolPolicy({
    provider: params.modelProvider,
    runtimeProvider: "codex",
    id: params.model,
  });
  assertCurrent();
  const webSearchAllowed =
    hostWebSearchAllowed && !isCodexDynamicToolExcluded(pluginConfig, ["web_search"]);
  const dynamicTools = params.dynamicTools;
  const nativeProviderWebSearchSupport = await resolveCodexProviderWebSearchSupportForClient({
    client: context.client,
    timeoutMs: appServer.requestTimeoutMs,
    modelProviderOverride: params.modelProvider,
    signal: AbortSignal.timeout(appServer.requestTimeoutMs),
  });
  assertCurrent();
  const webSearch = resolveCodexWebSearchPlan({
    config,
    nativeToolSurfaceEnabled: true,
    nativeProviderWebSearchSupport,
    webSearchAllowed,
  });
  const toolOverrides = resolveCodexMcpToolOverridesForAgent(config, {
    agentId: created.agentId,
    toolOverrides: created.entry.toolOverrides,
  });
  const bundleMcp = await loadCodexBundleMcpThreadConfig({
    workspaceDir,
    agentId: created.agentId,
    cfg: config,
    toolOverrides,
    preparationOnly: true,
  });
  assertCurrent();
  if (bundleMcp.diagnostics.length) {
    throw new Error("The child's MCP configuration could not be prepared completely.");
  }
  const userMcp = await buildCodexUserMcpServersThreadConfigPatchForRuntime(config, {
    agentId: created.agentId,
    agentDir: context.agentDir,
    toolOverrides,
    preparationOnly: true,
  });
  assertCurrent();
  // Creation has native tools and no scheduled run, so only configured app policy
  // needs preparation, including an explicit deny-all policy.
  const apps = shouldBuildCodexPluginThreadConfig(pluginConfig)
    ? await buildCodexPluginThreadConfig({
        pluginConfig,
        configCwd: cwd,
        appCacheKey: buildCodexPluginAppCacheKey({
          appServer,
          agentDir: context.agentDir,
          runtimeIdentity: context.client.getRuntimeIdentity(),
          desktopGenerationFingerprint: readCodexAppServerClientDesktopGenerationFingerprint(
            context.client,
          ),
        }),
        request: async (method, requestParams) => {
          assertCurrent();
          // Inventory reads may discover that setup is required; creation cannot
          // install plugins or rewrite native account/approval configuration.
          if (
            ![
              "plugin/list",
              "plugin/read",
              "plugin/installed",
              "app/list",
              "app/read",
              "app/installed",
              "config/read",
              "configRequirements/read",
            ].includes(method)
          ) {
            throw new Error("Codex plugin setup is required before native fork preparation.");
          }
          const response = await context.client.request(method, requestParams);
          assertCurrent();
          return response;
        },
      })
    : undefined;
  assertCurrent();
  if (apps?.diagnostics.length) {
    throw new Error(
      "Codex app policy is not ready for a native fork. Complete plugin setup and retry.",
    );
  }
  const nativeSkillIsolation = await resolveCodexNativeSkillIsolation({
    client: context.client,
    cwd,
    codexHome: appServer.start.env?.CODEX_HOME,
    home: appServer.start.env?.HOME,
    userProfile: appServer.start.env?.USERPROFILE,
  });
  assertCurrent();
  const generation = randomUUID();
  const relay = buildNativeHookRelayCommandPlan({
    provider: "codex",
    agentId: created.agentId,
    sessionKey: created.key,
    config,
    relayId: buildCodexNativeHookRelayId({
      agentId: created.agentId,
      sessionKey: created.key,
      sessionId: created.sessionId,
    }),
    generation,
    preToolUseLoopDetection: appServer.loopDetectionPreToolUseRelay,
  });
  const events = resolveCodexNativeHookRelayEvents({ appServer });
  if (events.includes("pre_tool_use") && relay.shouldRelayEvent("pre_tool_use")) {
    await assertCodexNativeHookRelayAllowed(context.client);
    assertCurrent();
  }
  await assertCodexModelBackedReviewerEffectiveConfig({
    client: context.client,
    approvalsReviewer: appServer.approvalsReviewer,
    cwd,
  });
  assertCurrent();
  const workspaceInstructions = await prepareCodexWorkspaceDeveloperInstructions({
    config,
    agentId: created.agentId,
    sessionKey: created.key,
    sessionId: created.sessionId,
    workspaceDir,
    cwd,
  });
  assertCurrent();
  const promptContext = {
    config,
    agentId: created.agentId,
    sessionKey: created.key,
    modelId: params.model,
  };
  const developerInstructions = [
    buildDeveloperInstructions(promptContext, { dynamicTools }),
    workspaceInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
  const bundleConfig = bundleMcp.configPatch;
  if (bundleConfig && !isJsonObject(bundleConfig)) {
    throw new Error("Invalid child MCP thread configuration");
  }
  const threadConfig = applyCodexNativeSkillIsolation(
    mergeCodexThreadConfigs(
      bundleConfig,
      userMcp,
      apps?.configPatch,
      appServer.networkProxy?.configPatch,
      buildCodexNativeHookRelayConfig({ relay, events, clearOmittedEvents: true }),
    ),
    nativeSkillIsolation,
  );
  const request = buildCodexThreadConfiguration(promptContext, {
    cwd,
    appServer,
    dynamicTools,
    developerInstructions,
    config: threadConfig,
    nativeCodeModeEnabled: true,
    nativeCodeModeOnlyEnabled: appServer.codeModeOnly,
    nativeProviderWebSearchSupport,
    webSearchAllowed,
    hostSystemAgentActive: false,
  });
  return {
    request,
    provisionalAppIds: apps?.provisionalAppIds ?? [],
    bindingPolicy: {
      nativeHookRelayGeneration: generation,
      agentWorkspaceDeveloperInstructions: workspaceInstructions,
      networkProxyProfileName: appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint: appServer.networkProxy?.configFingerprint,
      nativeSkillIsolationFingerprint: nativeSkillIsolation
        ? fingerprintJsonObject({
            version: 1,
            disabledUserSkillPaths: nativeSkillIsolation.disabledUserSkillPaths,
          })
        : undefined,
      userMcpServersFingerprint: fingerprintUserMcpServersConfigPatch(userMcp),
      mcpServersFingerprint: bundleMcp.fingerprint,
      webSearchThreadConfigFingerprint: fingerprintJsonObject(webSearch.threadConfig),
      pluginAppsFingerprint: apps?.fingerprint,
      pluginAppsInputFingerprint: apps?.inputFingerprint,
      pluginAppPolicyContext: apps?.policyContext,
    },
  };
}
