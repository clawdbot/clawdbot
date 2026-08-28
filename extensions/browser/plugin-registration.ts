/**
 * Browser plugin registration helpers. This file keeps registration lazy while
 * advertising Browser tools, services, node-host commands, and audits.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { registerBrowserNodeDelegation } from "openclaw/plugin-sdk/browser-node-delegation-runtime";
import { withBrowserStewardRuntimeAuthority } from "openclaw/plugin-sdk/browser-steward-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger, isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isBrowserMachineOutput } from "./cli-output-mode.js";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPE,
} from "./src/browser-gateway-contract.js";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
} from "./src/browser-node-commands.js";
import type { BrowserOwnedGatewayRequest } from "./src/browser-node-proxy.js";
import { parseBrowserTabToolBinding } from "./src/browser-tool-binding.js";
import { describeBrowserTool } from "./src/browser-tool-description.js";
import {
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  resolveBrowserToolCapabilities,
} from "./src/browser-tool.schema.js";
import {
  approveBrowserStewardRuntimeParams,
  createBrowserStewardRuntimeApprovalAuthority,
  createBrowserStewardGatewayApproval,
  getBrowserStewardRuntimeApprovalPromptBinding,
  isBrowserStewardRuntimeApproved,
  resolveBrowserStewardRuntimePolicyParams,
  finalizeBrowserStewardRuntimeParams,
  type BrowserStewardRuntimeApprovalAuthority,
} from "./src/browser/browser-steward-approval.js";
import {
  evaluateBrowserStewardRuntimeGuard,
  BROWSER_STEWARD_AGENT_ID,
  redactBrowserStewardCredentialMaterial,
  shouldApplyBrowserStewardRuntimeGuard,
} from "./src/browser/browser-steward-runtime-guard.js";
import { resolveBrowserConfig, resolveProfile } from "./src/browser/config.js";
import { getBrowserProfileCapabilities } from "./src/browser/profile-capabilities.js";
import { normalizeBrowserRequestPath } from "./src/browser/request-policy.js";
import { initializeBrowserSessionTabStore } from "./src/browser/session-tab-store.js";
import {
  configureSystemProfileImportStateStore,
  type SystemProfileImportState,
} from "./src/browser/system-profile-import-state.js";

const EAGER_BROWSER_CONTROL_SERVICE_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";
const logger = createSubsystemLogger("browser");

function safeApprovalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = sanitizeTerminalText(value.trim()).replace(/\p{Cf}/gu, "");
  return trimmed ? truncateUtf16Safe(trimmed, 96) : undefined;
}

function safeApprovalOrigin(value: unknown): string | undefined {
  const raw = safeApprovalText(value);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      return undefined;
    }
    return truncateUtf16Safe(url.origin, 128);
  } catch {
    return undefined;
  }
}

function describeBrowserStewardApprovalDestination(
  params: Record<string, unknown>,
  binding:
    | {
        backend: {
          kind: "host" | "sandbox" | "node";
          identity?: string;
        };
        origin?: string;
        profile?: string;
      }
    | undefined,
): string {
  const request =
    params.request && typeof params.request === "object" && !Array.isArray(params.request)
      ? (params.request as Record<string, unknown>) // SAFETY: the guard above excludes arrays and proves an object-shaped request.
      : undefined;
  const boundBackend = binding?.backend;
  const backendIdentity = safeApprovalText(
    redactBrowserStewardCredentialMaterial(boundBackend?.identity),
  );
  const backend = boundBackend
    ? `${boundBackend.kind}${backendIdentity ? `=${backendIdentity}` : ""}`
    : "unknown";
  const redactedProfile = redactBrowserStewardCredentialMaterial(binding?.profile);
  const profile = safeApprovalText(redactedProfile);
  const origin =
    safeApprovalOrigin(params.targetUrl) ??
    safeApprovalOrigin(params.url) ??
    safeApprovalOrigin(request?.url) ??
    safeApprovalOrigin(params.origin) ??
    safeApprovalOrigin(binding?.origin);
  return [
    `backend=${backend}`,
    profile ? `profile=${profile}` : undefined,
    origin ? `origin=${origin}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

const loadBrowserRegistrationRuntimeModule = createLazyRuntimeModule(
  () => import("./register.runtime.js"),
);
const loadBrowserUploadCleanupRuntimeModule = createLazyRuntimeModule(
  () => import("./src/browser-proxy-upload-cleanup.runtime.js"),
);

function deriveChatTypeFromSessionKey(
  sessionKey: string | undefined,
): "direct" | "group" | "channel" | undefined {
  const tokens = new Set(sessionKey?.toLowerCase().split(":").filter(Boolean) ?? []);
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  return undefined;
}

const BROWSER_CLI_DESCRIPTOR = {
  name: "browser",
  description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
  hasSubcommands: true,
  machineOutput: isBrowserMachineOutput,
};

function createLazyBrowserTool(
  opts?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
    agentSessionKey?: string;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
    activeModel?: {
      provider?: string;
      model?: string;
    };
    mediaScope?: {
      sessionKey?: string;
      channel?: string;
      chatType?: string;
    };
    approvalAuthority?: BrowserStewardRuntimeApprovalAuthority;
    browserOwnedGatewayRequest?: BrowserOwnedGatewayRequest;
    senderIsOwner?: boolean;
    runToolBinding?: unknown;
  },
  config?: OpenClawPluginToolContext["runtimeConfig"],
): AnyAgentTool {
  const bindingResult =
    opts?.runToolBinding === undefined
      ? undefined
      : parseBrowserTabToolBinding(opts.runToolBinding);
  if (bindingResult && !bindingResult.ok) {
    throw new Error(`invalid browser run binding: ${bindingResult.error}`);
  }
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  const boundProfile =
    bindingResult?.ok && bindingResult.binding.target === "host"
      ? resolveProfile(resolveBrowserConfig(config?.browser, config), bindingResult.binding.profile)
      : undefined;
  const capabilities = resolveBrowserToolCapabilities({
    tabBound: bindingResult?.ok,
    evaluateEnabled: config?.browser?.evaluateEnabled !== false,
    ...(boundProfile ? { profileCapabilities: getBrowserProfileCapabilities(boundProfile) } : {}),
  });
  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserTool({ targetDefault, hostHint, capabilities }),
    parameters: createBrowserToolSchema(capabilities),
    outputSchema: BrowserToolOutputSchema,
    prepareBeforeToolCallParams: async (params, context) => {
      const { prepareBrowserStewardToolParams } = await loadBrowserRegistrationRuntimeModule();
      return await prepareBrowserStewardToolParams({
        input: params,
        agentSessionKey: opts?.agentSessionKey,
        agentId: opts?.agentId,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
        allowHostControl: opts?.allowHostControl,
        ...(bindingResult?.ok ? { runToolBinding: bindingResult.binding } : {}),
        approvalAuthority: opts?.approvalAuthority,
        signal: context.signal,
      });
    },
    finalizeBeforeToolCallParams: (params, preparedParams) =>
      finalizeBrowserStewardRuntimeParams(params, preparedParams, opts?.approvalAuthority),
    execute: async (toolCallId, args, signal, onUpdate) => {
      const { createBrowserTool } = await loadBrowserRegistrationRuntimeModule();
      const tool = createBrowserTool(
        bindingResult?.ok
          ? {
              ...opts,
              runToolBinding: bindingResult.binding,
              toolCapabilities: capabilities,
            }
          : { ...opts, toolCapabilities: capabilities },
      );
      return await tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

type BrowserStewardTrustedToolPolicy = Parameters<
  OpenClawPluginApi["registerTrustedToolPolicy"]
>[0];

function createBrowserStewardTrustedToolPolicy(
  approvalAuthority: BrowserStewardRuntimeApprovalAuthority,
): BrowserStewardTrustedToolPolicy {
  return {
    id: "browser-steward-runtime-approval",
    description: "Requires exact, one-shot approval before Browser Steward mutations.",
    matcher: ["browser"],
    evaluate: (event, context) => {
      if (
        !shouldApplyBrowserStewardRuntimeGuard({
          sessionKey: context.sessionKey,
          agentId: context.agentId,
        }) ||
        isBrowserStewardRuntimeApproved(event.params, approvalAuthority)
      ) {
        return undefined;
      }
      const policyParams = resolveBrowserStewardRuntimePolicyParams(
        event.params,
        approvalAuthority,
      );
      const action = typeof policyParams.action === "string" ? policyParams.action : "unknown";
      const decision = evaluateBrowserStewardRuntimeGuard({
        action,
        profile: typeof policyParams.profile === "string" ? policyParams.profile : undefined,
        agentSessionKey: context.sessionKey,
        agentId: context.agentId,
        request: policyParams.request ?? policyParams,
      });
      if (!decision.approvalRequired) {
        return undefined;
      }
      const approvalParams = event.params;
      const destination = describeBrowserStewardApprovalDestination(
        policyParams,
        getBrowserStewardRuntimeApprovalPromptBinding(event.params, approvalAuthority),
      );
      return {
        requireApproval: {
          title: "Approve Browser Steward action",
          description: `Approve ${decision.requestedAction} (${destination}) for ${decision.affectedSession}.`,
          severity: decision.dataSensitivity === "critical" ? "critical" : "warning",
          allowedDecisions: ["allow-once", "deny"],
          pluginId: "browser",
          onResolution: (resolution) => {
            if (resolution === "allow-once") {
              approveBrowserStewardRuntimeParams(approvalParams, approvalAuthority);
            }
          },
        },
      };
    },
  };
}

function createBrowserToolOptions(ctx: OpenClawPluginToolContext): {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel?: {
    provider?: string;
    model?: string;
  };
  mediaScope?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
  senderIsOwner?: boolean;
  runToolBinding?: unknown;
} {
  const mediaChannel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const mediaChatType = deriveChatTypeFromSessionKey(ctx.sessionKey);
  return {
    ...(ctx.browser?.sandboxBridgeUrl ? { sandboxBridgeUrl: ctx.browser.sandboxBridgeUrl } : {}),
    ...(ctx.browser?.allowHostControl !== undefined
      ? { allowHostControl: ctx.browser.allowHostControl }
      : {}),
    ...(ctx.sessionKey ? { agentSessionKey: ctx.sessionKey } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
    ...(ctx.activeModel?.provider || ctx.activeModel?.modelId
      ? {
          activeModel: {
            provider: ctx.activeModel.provider,
            model: ctx.activeModel.modelId,
          },
        }
      : {}),
    ...(ctx.sessionKey || mediaChannel
      ? {
          mediaScope: {
            ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
            ...(mediaChannel ? { channel: mediaChannel } : {}),
            ...(mediaChatType ? { chatType: mediaChatType } : {}),
          },
        }
      : {}),
    ...(ctx.senderIsOwner !== undefined ? { senderIsOwner: ctx.senderIsOwner } : {}),
    ...(ctx.toolBindings && Object.hasOwn(ctx.toolBindings, "browser")
      ? { runToolBinding: ctx.toolBindings.browser }
      : {}),
  };
}

/** Browser plugin reload policy. */
export const browserPluginReload = {
  restartPrefixes: ["browser"],
  hotPrefixes: ["browser.profiles"],
};

/** Node-host command descriptors exposed by the Browser plugin. */
function createBrowserProxyNodeHostCommand(command: string): OpenClawPluginNodeHostCommand {
  return {
    command,
    cap: "browser",
    isAvailable: ({ config }) =>
      config.browser?.enabled !== false && config.nodeHost?.browserProxy?.enabled !== false,
    handle: async (paramsJSON, _io, context) => {
      const { runBrowserProxyCommand } = await loadBrowserRegistrationRuntimeModule();
      return await runBrowserProxyCommand(
        paramsJSON,
        command,
        context?.signal,
        context?.nodeId && context.invocationId && context.pairingGeneration
          ? {
              nodeId: context.nodeId,
              invocationId: context.invocationId,
              pairingGeneration: context.pairingGeneration,
            }
          : undefined,
      );
    },
    ...(command === BROWSER_PROXY_UPLOAD_COMMAND
      ? {
          watchAvailability: () => {
            void loadBrowserUploadCleanupRuntimeModule()
              .then(({ ensureBrowserProxyUploadCleanup }) => ensureBrowserProxyUploadCleanup())
              .catch((error: unknown) => {
                logger.warn(`browser proxy upload cleanup startup failed: ${String(error)}`);
              });
          },
        }
      : {}),
  };
}

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  createBrowserProxyNodeHostCommand(BROWSER_PROXY_COMMAND),
  createBrowserProxyNodeHostCommand(BROWSER_PROXY_UPLOAD_COMMAND),
];

function createBrowserProxyNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [BROWSER_PROXY_COMMAND, BROWSER_PROXY_UPLOAD_COMMAND],
    classifyRisk: () => ({ level: "high" as const, family: "browser-steward" }),
    handle: async (ctx) => {
      if (!ctx.client?.scopes?.includes(BROWSER_REQUEST_GATEWAY_SCOPE)) {
        return {
          ok: false,
          code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
          message: "browser node control requires operator admin authority",
        };
      }
      if (ctx.pluginRuntimeOwnerId) {
        return {
          ok: false,
          code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
          message: "browser node control requires the Browser-owned capability",
        };
      }
      const trustedAgentId = normalizeOptionalString(ctx.agentId);
      const trustedSessionKey = normalizeOptionalString(ctx.sessionKey);
      const hasTrustedAgentRuntime = Boolean(trustedAgentId || trustedSessionKey);
      if (hasTrustedAgentRuntime) {
        return {
          ok: false,
          code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
          message: "browser node control requires an approved Browser tool operation",
        };
      }
      const rawParams = isRecord(ctx.params) ? ctx.params : undefined;
      const method = typeof rawParams?.method === "string" ? rawParams.method.toUpperCase() : "";
      const path = typeof rawParams?.path === "string" ? rawParams.path : "";
      if (!method || !path) {
        return {
          ok: false,
          code: "BROWSER_STEWARD_INVALID_REQUEST",
          message: "browser node control requires method and path",
        };
      }
      if (method !== "GET" && method !== "POST" && method !== "DELETE") {
        return {
          ok: false,
          code: "BROWSER_STEWARD_INVALID_REQUEST",
          message: "browser node control method is unsupported",
        };
      }
      const normalizedPath = normalizeBrowserRequestPath(path);
      const requestedProfile =
        typeof rawParams?.profile === "string" ? rawParams.profile : undefined;
      const profile =
        normalizedPath === "/profiles"
          ? ""
          : (requestedProfile ??
            resolveBrowserConfig(ctx.config.browser, ctx.config).defaultProfile);
      const invocationId = normalizeOptionalString(ctx.idempotencyKey) ?? randomUUID();
      const browserProxyTimeoutMs = rawParams?.browserProxyTimeoutMs ?? rawParams?.timeoutMs;
      const commandParams = {
        method,
        path,
        ...(rawParams?.query !== undefined ? { query: rawParams.query } : {}),
        ...(rawParams?.body !== undefined ? { body: rawParams.body } : {}),
        ...(rawParams?.upload !== undefined ? { upload: rawParams.upload } : {}),
        ...(browserProxyTimeoutMs !== undefined ? { timeoutMs: browserProxyTimeoutMs } : {}),
        profile,
        agentId: BROWSER_STEWARD_AGENT_ID,
      } satisfies Record<string, unknown>;
      let approval: ReturnType<typeof createBrowserStewardGatewayApproval>;
      try {
        approval = createBrowserStewardGatewayApproval({
          command: ctx.command,
          method,
          path,
          query: rawParams?.query,
          body: rawParams?.body,
          upload: rawParams?.upload,
          profile,
          agentId: BROWSER_STEWARD_AGENT_ID,
          nodeId: ctx.nodeId,
          pairingGeneration: ctx.node?.pairingGeneration ?? "",
          invocationId,
        });
      } catch {
        return {
          ok: false,
          code: "BROWSER_STEWARD_INVALID_REQUEST",
          message: "browser node control approval could not be created",
        };
      }
      const forwardedParams = {
        ...commandParams,
        browserStewardApproval: approval,
      };
      const result = await ctx.invokeNode({
        params: forwardedParams,
        timeoutMs: ctx.timeoutMs,
        idempotencyKey: invocationId,
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          message: result.message,
          ...(result.details ? { details: result.details } : {}),
        };
      }
      return {
        ok: true,
        ...(result.payload !== undefined ? { payload: result.payload } : {}),
        ...(result.payloadJSON !== undefined ? { payloadJSON: result.payloadJSON } : {}),
      };
    },
  };
}

/** Security audit collectors contributed by the Browser plugin. */
export const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[] = [
  async (ctx) => {
    const { collectBrowserSecurityAuditFindings } = await loadBrowserRegistrationRuntimeModule();
    return collectBrowserSecurityAuditFindings(ctx);
  },
];

type BrowserPluginLifecycle = {
  isActive: () => boolean;
  deactivate: () => void;
};

function createBrowserPluginLifecycle(): BrowserPluginLifecycle {
  let active = true;
  return Object.freeze({
    isActive: () => active,
    deactivate: () => {
      active = false;
    },
  });
}

function createBrowserOwnedGatewayRequest(
  api: OpenClawPluginApi,
  lifecycle: BrowserPluginLifecycle,
): BrowserOwnedGatewayRequest {
  return async (params) => {
    if (!lifecycle.isActive()) {
      throw new Error("Browser plugin lifecycle is no longer active.");
    }
    return await withBrowserStewardRuntimeAuthority(lifecycle.isActive, async () => {
      if (!lifecycle.isActive()) {
        throw new Error("Browser plugin lifecycle is no longer active.");
      }
      const result = await api.runtime.gateway.request(
        BROWSER_REQUEST_GATEWAY_METHOD,
        {
          method: params.method,
          path: params.path,
          ...(params.query ? { query: params.query } : {}),
          ...(params.body !== undefined ? { body: params.body } : {}),
          ...(params.profile ? { profile: params.profile } : {}),
          nodeId: params.nodeId,
          ...(params.browserNodeSessionLease
            ? { browserNodeSessionLease: params.browserNodeSessionLease }
            : {}),
          allowAutomaticHostFallback: false,
        },
        {
          timeoutMs: addTimerTimeoutGraceMs(params.timeoutMs) ?? params.timeoutMs,
          scopes: [BROWSER_REQUEST_GATEWAY_SCOPE],
        },
      );
      if (!lifecycle.isActive()) {
        throw new Error("Browser plugin lifecycle is no longer active.");
      }
      return result;
    });
  };
}

function createLazyBrowserPluginService(lifecycle: BrowserPluginLifecycle): OpenClawPluginService {
  let service: OpenClawPluginService | null = null;
  const loadService = async () => {
    if (!lifecycle.isActive()) {
      throw new Error("Browser plugin lifecycle is no longer active.");
    }
    if (!service) {
      const { createBrowserPluginService, stopBrowserControlService } =
        await loadBrowserRegistrationRuntimeModule();
      if (!lifecycle.isActive()) {
        throw new Error("Browser plugin lifecycle is no longer active.");
      }
      service = createBrowserPluginService({ stopOnDemand: stopBrowserControlService });
    }
    return service;
  };
  return {
    id: "browser-control",
    start: async (ctx) => {
      if (!lifecycle.isActive()) {
        return;
      }
      if (!isTruthyEnvValue(process.env[EAGER_BROWSER_CONTROL_SERVICE_ENV])) {
        return;
      }
      const loaded = await loadService();
      if (!lifecycle.isActive()) {
        return;
      }
      await loaded.start(ctx);
    },
    stop: async (ctx) => {
      lifecycle.deactivate();
      if (!service) {
        const loadedRuntime = loadBrowserRegistrationRuntimeModule.peek();
        if (!loadedRuntime) {
          return;
        }
        const { stopBrowserControlService } = await loadedRuntime;
        await stopBrowserControlService();
        return;
      }
      await service.stop?.(ctx);
    },
  };
}

/** Register Browser tool factories, CLI, gateway methods, services, and audits. */
export function registerBrowserPlugin(api: OpenClawPluginApi) {
  const approvalAuthority = createBrowserStewardRuntimeApprovalAuthority();
  const lifecycle = createBrowserPluginLifecycle();
  const browserOwnedGatewayRequest = createBrowserOwnedGatewayRequest(api, lifecycle);
  initializeBrowserSessionTabStore(api.runtime);
  configureSystemProfileImportStateStore(
    api.runtime.state.openKeyedStore<SystemProfileImportState>({
      namespace: "browser.system-profile-import",
      maxEntries: 1,
    }),
  );
  api.registerTool(((ctx: OpenClawPluginToolContext) => {
    const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
    return createLazyBrowserTool(
      { ...createBrowserToolOptions(ctx), approvalAuthority, browserOwnedGatewayRequest },
      config,
    );
  }) as OpenClawPluginToolFactory);
  registerBrowserNodeDelegation(api, {
    consumerPluginIds: ["google-meet", "teams-meetings", "zoom-meetings"],
    request: async ({ method, path, body, timeoutMs, nodeId }) =>
      await withBrowserStewardRuntimeAuthority(lifecycle.isActive, async () => {
        if (!lifecycle.isActive()) {
          throw new Error("Browser plugin lifecycle is no longer active.");
        }
        const result = await api.runtime.gateway.request(
          BROWSER_REQUEST_GATEWAY_METHOD,
          {
            method,
            path,
            ...(body !== undefined ? { body } : {}),
            timeoutMs,
            ...(nodeId ? { nodeId } : {}),
            agentId: BROWSER_STEWARD_AGENT_ID,
            allowAutomaticHostFallback: false,
          },
          {
            timeoutMs: addTimerTimeoutGraceMs(timeoutMs) ?? 1,
            scopes: [BROWSER_REQUEST_GATEWAY_SCOPE],
          },
        );
        if (!lifecycle.isActive()) {
          throw new Error("Browser plugin lifecycle is no longer active.");
        }
        return result;
      }),
  });
  api.registerTrustedToolPolicy(createBrowserStewardTrustedToolPolicy(approvalAuthority));
  api.registerNodeInvokePolicy(createBrowserProxyNodeInvokePolicy());
  api.registerCli(
    async ({ program }) => {
      const { registerBrowserCli } = await import("./src/cli/browser-cli.js");
      registerBrowserCli(program, process.argv, api.rootDir);
    },
    { commands: ["browser"], descriptors: [BROWSER_CLI_DESCRIPTOR] },
  );
  api.registerGatewayMethod(
    BROWSER_REQUEST_GATEWAY_METHOD,
    async (opts) => {
      const { handleBrowserGatewayRequest } = await loadBrowserRegistrationRuntimeModule();
      return await handleBrowserGatewayRequest(opts);
    },
    {
      scope: BROWSER_REQUEST_GATEWAY_SCOPE,
    },
  );
  // Remote extension relay: lets the Chrome extension connect directly to this
  // gateway over wss:// (no node host on the browser machine). auth:"plugin"
  // with no nodeCapability means the gateway does not pre-enforce token auth;
  // the handler self-validates the host-local relay secret. Path kept in sync
  // with GATEWAY_EXTENSION_RELAY_PATH (hardcoded here to stay lazy).
  api.registerHttpRoute({
    path: "/browser/extension",
    auth: "plugin",
    match: "exact",
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required: connect the OpenClaw Chrome extension over WebSocket.");
    },
    handleUpgrade: async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Direct relay activity prepares the teardown module consumed by lazy service shutdown.
      await loadBrowserRegistrationRuntimeModule();
      const { handleGatewayExtensionUpgrade } =
        await import("./src/browser/extension-relay/gateway-relay-route.js");
      return await handleGatewayExtensionUpgrade(req, socket, head);
    },
  });
  api.registerService(createLazyBrowserPluginService(lifecycle));
}
