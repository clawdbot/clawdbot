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
import {
  createBrowserToolSessionTabs,
  stripBrowserOpenInternalMetadata,
} from "./browser-tool-session-tabs.js";
import {
  executeActAction,
  executeConsoleAction,
  executeDownloadAction,
  executeEmulateAction,
  executeRequestsAction,
  executeErrorsAction,
  executeTextAction,
  executeTabsAction,
  formatBrowserExternalToolResult,
} from "./browser-tool.actions.js";
import { executeBrowserLifecycleAction } from "./browser-tool.lifecycle.js";
import {
  resolveBrowserBaseUrl,
  resolveBrowserToolNodeTarget,
  resolveBrowserToolTimeoutMs,
  type BrowserNodeTarget,
} from "./browser-tool.routing.js";
import {
  type AnyAgentTool,
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  resolveBrowserToolCapabilities,
  type BrowserToolCapabilities,
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  getRuntimeConfig,
  getBrowserProfileCapabilities,
  jsonResult,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveExistingUploadPaths,
  resolveProfile,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser-tool.runtime.js";
import {
  executeScreenshotAction,
  type BrowserScreenshotOptions,
} from "./browser-tool.screenshot.js";
import { appendNavigatedPageState, executeSnapshotAction } from "./browser-tool.snapshot.js";
import { resolveBrowserNavigationTimeoutMs } from "./browser/act-policy.js";
import { parseBrowserNavigationUrl } from "./browser/navigation-guard.js";

function withBrowserTabDetails(
  result: AgentToolResult<unknown>,
  fallbackTargetId?: unknown,
): AgentToolResult<unknown> {
  // Control UI browser-tab preview card metadata; UI-only, replay strips details.
  try {
    const details = asNullableRecord(result.details);
    if (
      !details ||
      details.ok === false ||
      details.isError === true ||
      (Array.isArray(details.results) &&
        details.results.some((entry) => asNullableRecord(entry)?.ok === false)) ||
      asNullableRecord(details.aborted)?.reason === "closed"
    ) {
      return result;
    }
    const targetId = readStringValue(details.targetId) ?? readStringValue(fallbackTargetId);
    if (!targetId) {
      return result;
    }
    const url = readStringValue(details.url);
    const title = readStringValue(details.title);
    return {
      ...result,
      details: {
        ...details,
        browserTab: {
          targetId: truncateUtf16Safe(targetId, 128),
          ...(url ? { url: truncateUtf16Safe(url, 2048) } : {}),
          ...(title ? { title: truncateUtf16Safe(title, 512) } : {}),
        },
      },
    };
  } catch {
    return result;
  }
}

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = normalizeOptionalString(params.targetId);
  const timeoutMs = readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  const targetUrl =
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" });
  parseBrowserNavigationUrl(targetUrl);
  return targetUrl;
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
  const tool: AnyAgentTool = {
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
      const executeTrackedTabRequest = async (
        path: string,
        body: Record<string, unknown>,
        runLocal: () => Promise<unknown>,
      ) => {
        const result = proxyRequest
          ? await proxyRequest({ method: "POST", path, profile, body })
          : await runLocal();
        sessionTabs.touch(
          readStringValue((result as { targetId?: unknown }).targetId) ??
            readStringValue(body.targetId),
        );
        return jsonResult(result);
      };

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
        case "tabs":
          return await executeTabsAction({
            baseUrl,
            profile,
            timeoutMs: toolTimeoutMs,
            proxyRequest,
            targetId: bindingResult?.ok ? bindingResult.binding.targetId : undefined,
            signal,
          });
        case "open": {
          const targetUrl = readTargetUrlParam(params);
          const label = normalizeOptionalString(params.label);
          const opened = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/tabs/open",
                profile,
                body: { url: targetUrl, ...(label ? { label } : {}) },
                timeoutMs: toolTimeoutMs,
              })
            : await browserOpenTab(baseUrl, targetUrl, {
                profile,
                label,
                timeoutMs: toolTimeoutMs,
                signal,
              });
          const closeOpenedTab = async (targetId: string, openedProfile?: string) => {
            if (nodeRoute && !proxyRequest?.isHostFallbackActive()) {
              await nodeRoute.closeTarget({ targetId, profile: openedProfile });
              return;
            }
            await browserCloseTab(baseUrl, targetId, {
              profile: openedProfile,
              timeoutMs: toolTimeoutMs,
            });
          };
          await sessionTabs.trackOpened(opened, closeOpenedTab);
          return formatBrowserExternalToolResult({
            kind: "tabs",
            payload: stripBrowserOpenInternalMetadata(opened),
          });
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/tabs/focus",
                profile,
                body: { targetId },
                timeoutMs: toolTimeoutMs,
              })
            : await browserFocusTab(baseUrl, targetId, {
                profile,
                timeoutMs: toolTimeoutMs,
                signal,
              });
          sessionTabs.touch(
            readStringValue((result as { targetId?: unknown }).targetId) ?? targetId,
          );
          return jsonResult(result);
        }
        case "close": {
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = targetId
              ? await proxyRequest({
                  method: "DELETE",
                  path: `/tabs/${encodeURIComponent(targetId)}`,
                  profile,
                  timeoutMs: toolTimeoutMs,
                })
              : await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: { kind: "close" },
                  timeoutMs: toolTimeoutMs,
                });
            sessionTabs.untrack(
              readStringValue((result as { targetId?: unknown }).targetId) ?? targetId,
            );
            return jsonResult(result);
          }
          const result = targetId
            ? await browserCloseTab(baseUrl, targetId, {
                profile,
                timeoutMs: toolTimeoutMs,
                signal,
              })
            : await browserAct(
                baseUrl,
                { kind: "close" },
                {
                  profile,
                  timeoutMs: toolTimeoutMs,
                  signal,
                },
              );
          sessionTabs.untrack(readStringValue(result.targetId) ?? targetId);
          return jsonResult(result);
        }
        case "snapshot":
          return await executeSnapshotAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
            signal,
            onTabActivity: sessionTabs.touch,
          });
        case "screenshot":
          return await executeScreenshotAction({
            input: params,
            baseUrl,
            profile,
            requestedTimeoutMs,
            proxyRequest,
            signal,
            onTabActivity: sessionTabs.touch,
            opts,
          });
        case "navigate": {
          const targetUrl = readTargetUrlParam(params);
          const targetId = readStringParam(params, "targetId");
          const timeoutMs =
            requestedTimeoutMs === undefined
              ? undefined
              : resolveBrowserNavigationTimeoutMs(requestedTimeoutMs);
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/navigate",
                profile,
                body: {
                  url: targetUrl,
                  targetId,
                  timeoutMs,
                },
                timeoutMs,
              })
            : await browserNavigate(baseUrl, {
                url: targetUrl,
                targetId,
                timeoutMs,
                profile,
                signal,
              });
          const navigatedTargetId =
            readStringValue((result as { targetId?: unknown }).targetId) ?? targetId;
          sessionTabs.touch(navigatedTargetId);
          const formatted = formatBrowserExternalToolResult({
            kind: (result as { download?: unknown }).download ? "download" : "act",
            payload: result,
          });
          // A navigation that resolved to a download leaves the document
          // unchanged, so inline page state would describe the wrong thing.
          if ((result as { download?: unknown }).download) {
            return formatted;
          }
          return await appendNavigatedPageState({
            result: formatted,
            targetId: navigatedTargetId,
            baseUrl,
            profile,
            proxyRequest,
            signal,
          });
        }
        case "console": {
          const result = await executeConsoleAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
            signal,
          });
          const targetId = readStringParam(params, "targetId");
          const canonicalTargetId = readStringValue(
            (result.details as { targetId?: unknown } | undefined)?.targetId,
          );
          sessionTabs.touch(canonicalTargetId ?? targetId);
          return result;
        }
        case "requests":
        case "errors":
        case "text":
        case "emulate": {
          const execute = {
            requests: executeRequestsAction,
            errors: executeErrorsAction,
            text: executeTextAction,
            emulate: executeEmulateAction,
          }[action];
          const result = await execute({ input: params, baseUrl, profile, proxyRequest, signal });
          sessionTabs.touch(
            readStringValue(asNullableRecord(result.details)?.targetId) ??
              readStringValue(params.targetId),
          );
          return result;
        }
        case "pdf": {
          const targetId = normalizeOptionalString(params.targetId);
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserPdfSave(baseUrl, { targetId, profile, signal });
          sessionTabs.touch(readStringValue(result.targetId) ?? targetId);
          return {
            content: [{ type: "text" as const, text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "download":
        case "waitfordownload":
          return await executeDownloadAction({
            action,
            input: params,
            baseUrl,
            profile,
            proxyRequest,
            signal,
            onTabActivity: sessionTabs.touch,
          });
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) {
            throw new Error("paths required");
          }
          const resolvedResult = await resolveExistingUploadPaths({ requestedPaths: paths });
          if (!resolvedResult.ok) {
            throw new Error(resolvedResult.error);
          }
          const normalizedPaths = resolvedResult.paths;
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          const request = {
            paths: normalizedPaths,
            ref,
            inputRef,
            element,
            targetId,
            timeoutMs,
          };
          return await executeTrackedTabRequest(
            "/hooks/file-chooser",
            request,
            async () => await browserArmFileChooser(baseUrl, { ...request, profile, signal }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = readStringValue(params.promptText);
          const dialogId = readStringValue(params.dialogId);
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          const request = { accept, promptText, dialogId, targetId, timeoutMs };
          return await executeTrackedTabRequest(
            "/hooks/dialog",
            request,
            async () => await browserArmDialog(baseUrl, { ...request, profile, signal }),
          );
        }
        case "act": {
          const request = readActRequestParam(params);
          if (!request) {
            throw new Error("request required");
          }
          if (!capabilities.actKinds.some((kind) => kind === request.kind)) {
            throw new Error(
              `browser act kind ${JSON.stringify(request.kind)} is unavailable for this run`,
            );
          }
          return await executeActAction({
            request,
            baseUrl,
            profile,
            usesChromeMcp: isUserBrowserProfile,
            proxyRequest,
            signal,
            onTabActivity: sessionTabs.touch,
            onTabClose: sessionTabs.untrack,
          });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      const params = asNullableRecord(args[1]) ?? {};
      const action = readStringParam(params, "action", { required: true });
      const actRequest = action === "act" ? readActRequestParam(params) : undefined;
      const targetId =
        actRequest?.targetId ??
        params.targetId ??
        (bindingResult?.ok ? bindingResult.binding.targetId : undefined);
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
      ].includes(action) && actRequest?.kind !== "close"
        ? withBrowserTabDetails(result, targetId)
        : result;
    },
  };
}
