/**
 * Browser plugin registration helpers. This file keeps registration lazy while
 * advertising Browser tools, services, node-host commands, and audits.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger, isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { isBrowserMachineOutput } from "./cli-output-mode.js";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPE,
} from "./src/browser-gateway-contract.js";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
} from "./src/browser-node-commands.js";
import { parseBrowserTabToolBinding } from "./src/browser-tool-binding.js";
import { describeBrowserTool } from "./src/browser-tool-description.js";
import {
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  resolveBrowserToolCapabilities,
} from "./src/browser-tool.schema.js";
import { resolveBrowserConfig, resolveProfile } from "./src/browser/config.js";
import { getBrowserProfileCapabilities } from "./src/browser/profile-capabilities.js";
import { initializeBrowserSessionTabStore } from "./src/browser/session-tab-store.js";
import {
  configureSystemProfileImportStateStore,
  type SystemProfileImportState,
} from "./src/browser/system-profile-import-state.js";

const EAGER_BROWSER_CONTROL_SERVICE_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";
const logger = createSubsystemLogger("browser");

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
      return await runBrowserProxyCommand(paramsJSON, command, context?.signal);
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

/** Security audit collectors contributed by the Browser plugin. */
export const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[] = [
  async (ctx) => {
    const { collectBrowserSecurityAuditFindings } = await loadBrowserRegistrationRuntimeModule();
    return collectBrowserSecurityAuditFindings(ctx);
  },
];

function createLazyBrowserPluginService(): OpenClawPluginService {
  let service: OpenClawPluginService | null = null;
  const loadService = async () => {
    if (!service) {
      const { createBrowserPluginService, stopBrowserControlService } =
        await loadBrowserRegistrationRuntimeModule();
      service = createBrowserPluginService({ stopOnDemand: stopBrowserControlService });
    }
    return service;
  };
  return {
    id: "browser-control",
    start: async (ctx) => {
      if (!isTruthyEnvValue(process.env[EAGER_BROWSER_CONTROL_SERVICE_ENV])) {
        return;
      }
      const loaded = await loadService();
      await loaded.start(ctx);
    },
    stop: async (ctx) => {
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
  initializeBrowserSessionTabStore(api.runtime);
  configureSystemProfileImportStateStore(
    api.runtime.state.openKeyedStore<SystemProfileImportState>({
      namespace: "browser.system-profile-import",
      maxEntries: 1,
    }),
  );
  api.registerTool(((ctx: OpenClawPluginToolContext) => {
    const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
    return createLazyBrowserTool(createBrowserToolOptions(ctx), config);
  }) as OpenClawPluginToolFactory);
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
  api.registerService(createLazyBrowserPluginService());
}
