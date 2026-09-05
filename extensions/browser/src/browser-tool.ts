/**
 * Browser agent tool registration.
 *
 * Builds the model-facing browser tool, chooses sandbox/host/node routing, and
 * maps high-level actions onto browser control client calls.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  createBrowserNodeProxyRequest,
  createBrowserNodeSessionTabRoute,
} from "./browser-node-proxy.js";
import { applyBrowserTabToolBinding, parseBrowserTabToolBinding } from "./browser-tool-binding.js";
import { describeBrowserTool } from "./browser-tool-description.js";
import { executeBrowserTabAction } from "./browser-tool-dispatch.js";
import { createBrowserToolSessionTabs } from "./browser-tool-session-tabs.js";
import { executeBrowserLifecycleAction } from "./browser-tool.lifecycle.js";
import {
  resolveBrowserBaseUrl,
  resolveBrowserToolNodeTarget,
  resolveBrowserToolTimeoutMs,
  type BrowserNodeTarget,
} from "./browser-tool.routing.js";
import {
  type AnyAgentTool,
  type browserAct,
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  resolveBrowserToolCapabilities,
  type BrowserToolCapabilities,
  getRuntimeConfig,
  getBrowserProfileCapabilities,
  readPositiveIntegerParam,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveProfile,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser-tool.runtime.js";
import type { BrowserScreenshotOptions } from "./browser-tool.screenshot.js";

type BrowserTabIdentity = { targetId: string; profile: string } & (
  | { target: "host" }
  | { target: "node"; node: string }
);

function isBrowserRouteIdentifier(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value
  );
}

function resolveBrowserTabIdentity(params: {
  targetId?: string;
  profile?: string;
  target: "host" | "node";
  node?: string;
  baseUrl?: string;
}): BrowserTabIdentity | undefined {
  // Bridge/sandbox tabs have no operator browser.request route. Identity must
  // remain exact: truncation could address another tab, profile, or node.
  if (
    params.baseUrl ||
    !isBrowserRouteIdentifier(params.targetId, 128) ||
    !isBrowserRouteIdentifier(params.profile, 128)
  ) {
    return undefined;
  }
  if (params.target === "node") {
    return isBrowserRouteIdentifier(params.node, 256)
      ? { targetId: params.targetId, profile: params.profile, target: "node", node: params.node }
      : undefined;
  }
  return { targetId: params.targetId, profile: params.profile, target: "host" };
}

function withBrowserTabDetails(
  result: AgentToolResult<unknown>,
  identity: BrowserTabIdentity | undefined,
): AgentToolResult<unknown> {
  // UI addressing only; normal tool content and authorization stay unchanged.
  const details = asNullableRecord(result.details);
  if (
    !identity ||
    !details ||
    details.ok === false ||
    details.isError === true ||
    (Array.isArray(details.results) &&
      details.results.some((entry) => asNullableRecord(entry)?.ok === false)) ||
    asNullableRecord(details.aborted)?.reason === "closed"
  ) {
    return result;
  }
  const url = readStringValue(details.url);
  const title = readStringValue(details.title);
  return {
    ...result,
    details: {
      ...details,
      browserTab: {
        ...identity,
        ...(url ? { url: truncateUtf16Safe(url, 2048) } : {}),
        ...(title ? { title: truncateUtf16Safe(title, 512) } : {}),
      },
    },
  };
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
  "kind",
  "actions",
  "stopOnError",
  "targetId",
  "ref",
  "doubleClick",
  "button",
  "modifiers",
  "x",
  "y",
  "text",
  "submit",
  "slowly",
  "key",
  "delayMs",
  "startRef",
  "endRef",
  "values",
  "fields",
  "width",
  "height",
  "timeMs",
  "textGone",
  "selector",
  "url",
  "loadState",
  "fn",
  "timeoutMs",
] as const;

const LEGACY_BROWSER_ACT_SHARED_REQUEST_KEYS = new Set<
  (typeof LEGACY_BROWSER_ACT_REQUEST_KEYS)[number]
>(["targetId"]);

function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  if (requestParam && typeof requestParam === "object") {
    const request = { ...(requestParam as Record<string, unknown>) };
    const hasMismatchedKind =
      typeof request.kind === "string" &&
      typeof params.kind === "string" &&
      request.kind !== params.kind;
    for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
      if (Object.hasOwn(request, key) || !Object.hasOwn(params, key)) {
        continue;
      }
      // Flattened act fields are legacy shape repair. Only the tab scope is
      // safe across kind mismatches; action-specific fields can corrupt the
      // explicit nested request.
      if (hasMismatchedKind && !LEGACY_BROWSER_ACT_SHARED_REQUEST_KEYS.has(key)) {
        continue;
      }
      request[key] = params[key];
    }
    return request as Parameters<typeof browserAct>[1];
  }

  const kind = readStringParam(params, "kind");
  if (!kind) {
    return undefined;
  }

  const request: Record<string, unknown> = {};
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    request[key] = params[key];
  }
  return request as Parameters<typeof browserAct>[1];
}

function readToolTimeoutMs(params: Record<string, unknown>) {
  return readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
}

/** Create the Browser tool exposed to agents. */
export function createBrowserTool(
  opts?: BrowserScreenshotOptions & {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
    agentSessionKey?: string;
    runToolBinding?: unknown;
    toolCapabilities?: BrowserToolCapabilities;
  },
): AnyAgentTool {
  const bindingResult =
    opts?.runToolBinding === undefined
      ? undefined
      : parseBrowserTabToolBinding(opts.runToolBinding);
  if (bindingResult && !bindingResult.ok) {
    throw new Error(`invalid browser run binding: ${bindingResult.error}`);
  }
  const capabilities =
    opts?.toolCapabilities ??
    (() => {
      const config = getRuntimeConfig();
      const boundProfile =
        bindingResult?.ok && bindingResult.binding.target === "host"
          ? resolveProfile(
              resolveBrowserConfig(config.browser, config),
              bindingResult.binding.profile,
            )
          : undefined;
      return resolveBrowserToolCapabilities({
        tabBound: bindingResult?.ok,
        evaluateEnabled: config.browser?.evaluateEnabled !== false,
        ...(boundProfile
          ? { profileCapabilities: getBrowserProfileCapabilities(boundProfile) }
          : {}),
      });
    })();
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserTool({ targetDefault, hostHint, capabilities }),
    parameters: createBrowserToolSchema(capabilities),
    outputSchema: BrowserToolOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = bindingResult?.ok
        ? applyBrowserTabToolBinding(args as Record<string, unknown>, bindingResult.binding)
        : (args as Record<string, unknown>);
      const action = readStringParam(params, "action", { required: true });
      if (!capabilities.actions.some((candidate) => candidate === action)) {
        throw new Error(
          `browser action ${JSON.stringify(action)} is unavailable for this run; use an available action such as snapshot, or select a managed browser profile in an unbound run.`,
        );
      }
      const requestedProfile = readStringParam(params, "profile");
      const requestedNode = readStringParam(params, "node");
      const requestedTimeoutMs = readToolTimeoutMs(params);
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;
      const runtimeConfig = getRuntimeConfig();
      const resolvedBrowser = resolveBrowserConfig(runtimeConfig.browser, runtimeConfig);
      const effectiveProfile = requestedProfile ?? resolvedBrowser.defaultProfile;
      const resolvedProfile = resolveProfile(resolvedBrowser, effectiveProfile);
      const profileCapabilities = resolvedProfile
        ? getBrowserProfileCapabilities(resolvedProfile)
        : undefined;
      let profile = profileCapabilities?.usesChromeMcp ? effectiveProfile : requestedProfile;
      const configuredNode = runtimeConfig.gateway?.nodes?.browser?.node?.trim();

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }

      // System-profile import reads the local macOS Keychain and Chrome profile,
      // so it can only run on the host. Pin it before target/node resolution so a
      // sandbox default or auto-selected browser node never receives the request.
      if (action === "importprofile") {
        if (target === "sandbox" || target === "node" || requestedNode) {
          throw new Error(
            'system profile import must run on the host; omit target or use target="host".',
          );
        }
        target = "host";
      }
      // existing-session profiles can attach through the selected host or browser node,
      // but they must never fall back into the sandbox browser.
      const isUserBrowserProfile = profileCapabilities?.usesChromeMcp === true;
      if (isUserBrowserProfile) {
        if (target === "sandbox") {
          throw new Error(
            `profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`,
          );
        }
      }

      let nodeTarget: BrowserNodeTarget | null = null;
      try {
        nodeTarget = await resolveBrowserToolNodeTarget({
          requestedNode: requestedNode ?? undefined,
          target,
          sandboxBridgeUrl: opts?.sandboxBridgeUrl,
          allowHostControl: opts?.allowHostControl,
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        // Keep the logged-in user browser usable on the host when auto-discovery
        // of browser nodes fails transiently. Explicit node requests still fail.
        if (!(isUserBrowserProfile && !target && !requestedNode && !configuredNode)) {
          throw error;
        }
      }
      if (isUserBrowserProfile && !target && !requestedNode && !nodeTarget) {
        target = "host";
      }

      const resolvedTarget = target === "node" ? undefined : target;
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: resolvedTarget,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      const allowAutomaticHostFallback = Boolean(
        nodeTarget &&
        !target &&
        !requestedNode &&
        !configuredNode &&
        opts?.allowHostControl !== false,
      );
      const proxyRequest = nodeTarget
        ? createBrowserNodeProxyRequest({ nodeTarget, allowAutomaticHostFallback, signal })
        : null;
      if (proxyRequest) {
        // The node resolves omissions against its own config; Gateway defaults
        // never cross this execution-owner boundary.
        profile = requestedProfile;
      }
      if (
        !proxyRequest &&
        isUserBrowserProfile &&
        ["requests", "errors", "text", "emulate"].includes(action)
      ) {
        throw new Error(
          `action=${action} is not supported for existing-session profiles; use action=snapshot to inspect this page, or select a managed browser profile for ${action}.`,
        );
      }
      const nodeRoute = nodeTarget ? createBrowserNodeSessionTabRoute(nodeTarget) : undefined;
      const toolTimeoutMs = resolveBrowserToolTimeoutMs({
        requestedTimeoutMs,
        action,
        isUserBrowserProfile,
        usesPersistentPlaywright: profileCapabilities?.usesPersistentPlaywright === true,
        isNodeProxy: proxyRequest !== null,
        resolvedBrowser,
      });
      const sessionTabs = createBrowserToolSessionTabs({
        sessionKey: opts?.agentSessionKey,
        requestedProfile: profile,
        defaultProfile: resolvedBrowser.defaultProfile,
        baseUrl,
        nodeRoute,
        routeProfile: () => {
          const route = proxyRequest?.route();
          return route?.status === "resolved" ? route.profile : undefined;
        },
        isHostFallbackActive: proxyRequest?.isHostFallbackActive,
        registry: { touchSessionBrowserTab, trackSessionBrowserTab, untrackSessionBrowserTab },
      });
      switch (action) {
        case "doctor":
        case "status":
        case "start":
        case "stop":
        case "profiles":
        case "importprofile":
          return await executeBrowserLifecycleAction({
            action,
            input: params,
            baseUrl,
            profile,
            timeoutMs: toolTimeoutMs,
            proxyRequest,
            allowHostControl: opts?.allowHostControl,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            signal,
          });
        default:
          break;
      }
      let tabIdentity: BrowserTabIdentity | undefined;
      const result = await executeBrowserTabAction({
        action,
        actRequest: action === "act" ? readActRequestParam(params) : undefined,
        params,
        baseUrl,
        profile,
        proxyRequest,
        nodeRoute,
        sessionTabs,
        capabilities,
        isUserBrowserProfile,
        toolTimeoutMs,
        requestedTimeoutMs,
        signal,
        opts,
        boundTargetId: bindingResult?.ok ? bindingResult.binding.targetId : undefined,
        onTabActivity: (targetId, openedProfile) => {
          // Record the executed tab before follow-up observation adds page state.
          const route = proxyRequest?.route();
          const onNode = proxyRequest && !proxyRequest.isHostFallbackActive();
          const routeProfile = onNode
            ? route?.status === "resolved"
              ? route.profile
              : undefined
            : (profile ?? resolvedBrowser.defaultProfile);
          tabIdentity = resolveBrowserTabIdentity({
            targetId,
            baseUrl,
            profile: openedProfile ?? routeProfile,
            target: onNode ? "node" : "host",
            node: onNode && route?.status === "resolved" ? nodeTarget?.nodeId : undefined,
          });
        },
      });
      return [
        "open",
        "focus",
        "navigate",
        "screenshot",
        "snapshot",
        "text",
        "requests",
        "errors",
        "console",
        "emulate",
        "act",
      ].includes(action)
        ? withBrowserTabDetails(result, tabIdentity)
        : result;
    },
  };
}
