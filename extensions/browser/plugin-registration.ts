/**
 * Browser plugin registration helpers. This file keeps registration lazy while
 * advertising Browser tools, services, node-host commands, and audits.
 */
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPE,
} from "./src/browser-gateway-contract.js";
import { BrowserToolSchema } from "./src/browser-tool.schema.js";

const EAGER_BROWSER_CONTROL_SERVICE_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";

let browserRegistrationRuntimeModulePromise: Promise<
  typeof import("./register.runtime.js")
> | null = null;

const loadBrowserRegistrationRuntimeModule = async () => {
  browserRegistrationRuntimeModulePromise ??= import("./register.runtime.js");
  return await browserRegistrationRuntimeModulePromise;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

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
};

function createLazyBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
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
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
      "Browser choice: omit profile by default for the isolated OpenClaw-managed browser (`openclaw`).",
      'For the logged-in user browser, use profile="user". A supported Chromium-based browser (v144+) must be running on the selected host or browser node. Use only when existing logins/cookies matter and the user is present.',
      'For profile="user" or other existing-session profiles, omit timeoutMs on act:type, evaluate, hover, scrollIntoView, drag, select, and fill; that driver rejects per-call timeout overrides for those actions.',
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc). For tab operations, targetId also accepts tabId handles (t1) and labels from action=tabs.",
      "For multi-step browser work, login checks, stale refs, duplicate tabs, or Google Meet flows, use the bundled browser-automation skill when it is available.",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      `target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
      hostHint,
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const { createBrowserTool } = await loadBrowserRegistrationRuntimeModule();
      const tool = createBrowserTool(opts);
      return await tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

function createBrowserToolOptions(ctx: OpenClawPluginToolContext): {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
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
} {
  const mediaChannel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const mediaChatType = deriveChatTypeFromSessionKey(ctx.sessionKey);
  return {
    ...(ctx.browser?.sandboxBridgeUrl ? { sandboxBridgeUrl: ctx.browser.sandboxBridgeUrl } : {}),
    ...(ctx.browser?.allowHostControl !== undefined
      ? { allowHostControl: ctx.browser.allowHostControl }
      : {}),
    ...(ctx.sessionKey ? { agentSessionKey: ctx.sessionKey } : {}),
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
  };
}

/** Browser plugin reload policy. */
export const browserPluginReload = { restartPrefixes: ["browser"] };

/** Node-host command descriptors exposed by the Browser plugin. */
export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "browser.proxy",
    cap: "browser",
    handle: async (paramsJSON) => {
      const { runBrowserProxyCommand } = await loadBrowserRegistrationRuntimeModule();
      return await runBrowserProxyCommand(paramsJSON);
    },
  },
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
      const { createBrowserPluginService } = await loadBrowserRegistrationRuntimeModule();
      service = createBrowserPluginService();
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
        const { stopBrowserControlService } = await import("./src/control-service.js");
        await stopBrowserControlService().catch(() => {});
        return;
      }
      await service.stop?.(ctx);
    },
  };
}

/** Register Browser tool factories, CLI, gateway methods, services, and audits. */
export function registerBrowserPlugin(api: OpenClawPluginApi) {
  api.registerTool(((ctx: OpenClawPluginToolContext) =>
    createLazyBrowserTool(createBrowserToolOptions(ctx))) as OpenClawPluginToolFactory);
  api.registerCli(
    async ({ program }) => {
      const { registerBrowserCli } = await import("./src/cli/browser-cli.js");
      registerBrowserCli(program);
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
  api.registerService(createLazyBrowserPluginService());
}
