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
import { resolveBrowserNodeTarget } from "./browser-node-routing.js";
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
  executeTextAction,
  executeTabsAction,
  formatBrowserExternalToolResult,
} from "./browser-tool.actions.js";
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
  browserDoctor,
  browserFocusTab,
  browserImportProfile,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  browserProfiles,
  browserSystemProfiles,
  browserScreenshotAction,
  browserStart,
  browserStatus,
  browserStop,
  describeImageFile,
  getRuntimeConfig,
  getBrowserProfileCapabilities,
  imageResultFromFile,
  jsonResult,
  listNodes,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveExistingUploadPaths,
  resolveRuntimeImageSanitization,
  resolveProfile,
  saveMediaBuffer,
  stageBrowserScreenshotForSharing,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser-tool.runtime.js";
import { appendNavigatedPageState, executeSnapshotAction } from "./browser-tool.snapshot.js";
import { resolveBrowserNavigationTimeoutMs } from "./browser/act-policy.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "./browser/constants.js";
import { parseBrowserNavigationUrl } from "./browser/navigation-guard.js";
import { normalizeBrowserScreenshot } from "./browser/screenshot.js";
import { parseSystemProfileDomains } from "./browser/system-profile-domains.js";
import { describeBrowserScreenshot, neutralizeMediaDirectives } from "./browser/vision.js";
import { wrapExternalContent } from "./sdk-security-runtime.js";

const browserToolDeps = {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserImportProfile,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  browserProfiles,
  browserSystemProfiles,
  browserScreenshotAction,
  browserStart,
  browserStatus,
  browserStop,
  describeImageFile,
  getRuntimeConfig,
  imageResultFromFile,
  listNodes,
  normalizeBrowserScreenshot,
  saveMediaBuffer,
  stageBrowserScreenshotForSharing,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
};

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

function formatScreenshotShareHint(filePath: string): string {
  return `[Screenshot saved to ${JSON.stringify(filePath)}. A sanitized outbound copy is ready at this path for explicit sharing.]`;
}

const SCREENSHOT_SHARE_UNAVAILABLE =
  "[Screenshot sharing is unavailable because an outbound copy could not be prepared.]";

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

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
  commands: string[];
  pendingDeclaredCommands: string[];
};

async function resolveBrowserToolNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  signal?: AbortSignal;
}): Promise<BrowserNodeTarget | null> {
  if (params.allowHostControl === false) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser control is disabled by sandbox policy.");
    }
    return null;
  }

  const cfg = browserToolDeps.getRuntimeConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const explicitTarget = params.target === "node";
  const requestedNode = params.requestedNode?.trim();
  if (policy?.mode === "off") {
    resolveBrowserNodeTarget({ nodes: [], policy, requestedNode, explicitTarget });
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && !explicitTarget && !requestedNode) {
    return null;
  }
  if (params.target && !explicitTarget) {
    return null;
  }
  if (policy?.mode === "manual" && !explicitTarget && !requestedNode && !policy.node?.trim()) {
    return null;
  }
  const node = resolveBrowserNodeTarget({
    nodes: await browserToolDeps.listNodes({}, params.signal),
    policy,
    requestedNode,
    explicitTarget,
    requireConnected: true,
  });
  return node
    ? {
        nodeId: node.nodeId,
        label: node.displayName ?? node.remoteIp ?? node.nodeId,
        commands: node.commands ?? [],
        pendingDeclaredCommands: node.pendingDeclaredCommands ?? [],
      }
    : null;
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.openclaw/openclaw.json.",
    );
  }
  return undefined;
}

const unavailableSystemProfiles = (unavailableReason: string) => ({
  profiles: [],
  unavailableReason,
});

/**
 * Read importable system profiles from the host control server. Discovery must
 * match where import runs (host-local), so it never uses a node proxy or the
 * sandbox base URL. Other profile sources remain useful when host discovery
 * is unavailable, so failures become an explicit degradation fact.
 */
async function readHostSystemProfiles(params: {
  allowHostControl?: boolean;
  sandboxBridgeUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  if (params.allowHostControl === false) {
    return unavailableSystemProfiles(
      "Host system profile discovery is disabled by sandbox policy; enable host control to discover importable system profiles.",
    );
  }
  let hostBaseUrl: string | undefined;
  try {
    hostBaseUrl = resolveBrowserBaseUrl({
      target: "host",
      sandboxBridgeUrl: params.sandboxBridgeUrl,
      allowHostControl: params.allowHostControl,
    });
  } catch {
    return unavailableSystemProfiles(
      'Host browser control is unavailable; enable it and retry action=profiles target="host".',
    );
  }
  try {
    return {
      profiles: await browserToolDeps.browserSystemProfiles(hostBaseUrl, {
        timeoutMs: params.timeoutMs,
        signal: params.signal,
      }),
      unavailableReason: undefined,
    };
  } catch {
    params.signal?.throwIfAborted();
    return unavailableSystemProfiles(
      'Host system profile discovery failed; retry action=profiles target="host" after host browser control is available.',
    );
  }
}

const DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS = 45_000;
const EXISTING_SESSION_MANAGE_ACTIONS = new Set([
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
]);

function hasExistingSessionProfile(resolved: ReturnType<typeof resolveBrowserConfig>) {
  return Object.keys(resolved.profiles).some((name) => {
    const candidate = resolveProfile(resolved, name);
    return candidate ? getBrowserProfileCapabilities(candidate).usesChromeMcp : false;
  });
}

function readToolTimeoutMs(params: Record<string, unknown>) {
  return readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
}

/** Create the Browser tool exposed to agents. */
export function createBrowserTool(opts?: {
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
  screenshotResultMode?: "image" | "path";
  persistScreenshot?: (params: {
    sourcePath: string;
    type: "png" | "jpeg";
    targetId?: string;
  }) => Promise<string>;
  mediaScope?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
  runToolBinding?: unknown;
  toolCapabilities?: BrowserToolCapabilities;
}): AnyAgentTool {
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
      const config = browserToolDeps.getRuntimeConfig();
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
      const runtimeConfig = browserToolDeps.getRuntimeConfig();
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
        ["requests", "text", "emulate"].includes(action)
      ) {
        throw new Error(
          `action=${action} is not supported for existing-session profiles; use action=snapshot to inspect this page, or select a managed browser profile for ${action}.`,
        );
      }
      const nodeRoute = nodeTarget ? createBrowserNodeSessionTabRoute(nodeTarget) : undefined;
      const toolTimeoutMs =
        requestedTimeoutMs ??
        (EXISTING_SESSION_MANAGE_ACTIONS.has(action) &&
        (isUserBrowserProfile ||
          (action === "profiles" && hasExistingSessionProfile(resolvedBrowser)))
          ? DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS
          : undefined);
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
        registry: browserToolDeps,
      });
      const readBrowserStatus = async () =>
        proxyRequest
          ? await proxyRequest({
              method: "GET",
              path: "/",
              profile,
              timeoutMs: toolTimeoutMs,
            })
          : await browserToolDeps.browserStatus(baseUrl, {
              profile,
              timeoutMs: toolTimeoutMs,
              signal,
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
          return jsonResult(
            proxyRequest
              ? await proxyRequest({ method: "GET", path: "/doctor", profile })
              : await browserToolDeps.browserDoctor(baseUrl, { profile, signal }),
          );
        case "status":
          return jsonResult(await readBrowserStatus());
        case "start":
        case "stop": {
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: `/${action}`,
              profile,
              timeoutMs: toolTimeoutMs,
            });
          } else {
            const updateBrowser =
              action === "start" ? browserToolDeps.browserStart : browserToolDeps.browserStop;
            await updateBrowser(baseUrl, { profile, timeoutMs: toolTimeoutMs, signal });
          }
          return jsonResult(await readBrowserStatus());
        }
        case "profiles": {
          // Importable system profiles are host-local (import runs on the host),
          // so read them from the host regardless of the profiles action target;
          // never let a node proxy or sandbox describe the wrong Chrome profiles.
          const { profiles: systemProfiles, unavailableReason: systemProfilesUnavailable } =
            await readHostSystemProfiles({
              allowHostControl: opts?.allowHostControl,
              sandboxBridgeUrl: opts?.sandboxBridgeUrl,
              timeoutMs: toolTimeoutMs,
              signal,
            });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
              timeoutMs: toolTimeoutMs,
            });
            return jsonResult({
              ...(result && typeof result === "object" ? result : { profiles: result }),
              systemProfiles,
              ...(systemProfilesUnavailable ? { systemProfilesUnavailable } : {}),
            });
          }
          return jsonResult({
            profiles: await browserToolDeps.browserProfiles(baseUrl, {
              timeoutMs: toolTimeoutMs,
              signal,
            }),
            systemProfiles,
            ...(systemProfilesUnavailable ? { systemProfilesUnavailable } : {}),
          });
        }
        case "importprofile": {
          if (proxyRequest) {
            throw new Error("system profile import must run on the browser host");
          }
          const domains = parseSystemProfileDomains(params.domains);
          return jsonResult(
            await browserToolDeps.browserImportProfile(baseUrl, {
              browser: normalizeOptionalString(params.browser) ?? "chrome",
              systemProfile: normalizeOptionalString(params.systemProfile) ?? "Default",
              into: normalizeOptionalString(params.into) ?? "imported",
              domains,
              signal,
            }),
          );
        }
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
            : await browserToolDeps.browserOpenTab(baseUrl, targetUrl, {
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
            await browserToolDeps.browserCloseTab(baseUrl, targetId, {
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
            : await browserToolDeps.browserFocusTab(baseUrl, targetId, {
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
            ? await browserToolDeps.browserCloseTab(baseUrl, targetId, {
                profile,
                timeoutMs: toolTimeoutMs,
                signal,
              })
            : await browserToolDeps.browserAct(
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
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const labels = typeof params.labels === "boolean" ? params.labels : undefined;
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const effectiveTimeoutMs = requestedTimeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                timeoutMs: effectiveTimeoutMs,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                  labels,
                  timeoutMs: effectiveTimeoutMs,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserToolDeps.browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                labels,
                timeoutMs: effectiveTimeoutMs,
                profile,
                signal,
              });
          sessionTabs.touch(readStringValue(result.targetId) ?? targetId);
          if (opts?.screenshotResultMode === "path") {
            const artifactPath = opts.persistScreenshot
              ? await opts.persistScreenshot({
                  sourcePath: result.path,
                  type,
                  targetId: readStringValue(result.targetId) ?? targetId,
                })
              : result.path;
            if (artifactPath.length > 4_096) {
              throw new Error("Browser screenshot artifact path exceeds 4096 characters");
            }
            const resultRecord = result as Record<string, unknown>;
            const resultTargetId = readStringValue(resultRecord.targetId) ?? targetId;
            const resultUrl = readStringValue(resultRecord.url);
            return jsonResult({
              ok: resultRecord.ok === true,
              path: artifactPath,
              ...(resultTargetId ? { targetId: truncateUtf16Safe(resultTargetId, 256) } : {}),
              ...(resultUrl ? { url: truncateUtf16Safe(resultUrl, 2_048) } : {}),
              ...(Array.isArray(resultRecord.annotations)
                ? { annotationCount: resultRecord.annotations.length }
                : {}),
              media: { outbound: false },
            });
          }
          const screenshotPath = result.path;
          const screenshotCfg = browserToolDeps.getRuntimeConfig();
          const imageSanitization = resolveRuntimeImageSanitization();
          let shareHint = SCREENSHOT_SHARE_UNAVAILABLE;
          try {
            // The original result remains private. Only this bounded outbound
            // copy may cross the sandbox boundary after an explicit message call.
            const sharePath = await browserToolDeps.stageBrowserScreenshotForSharing(
              screenshotPath,
              imageSanitization?.maxDimensionPx,
            );
            shareHint = formatScreenshotShareHint(sharePath);
          } catch {
            // Screenshot viewing remains useful when optional outbound staging fails.
          }
          // Screenshots stay in the tool result for agent vision, but channel
          // delivery must remain an explicit outbound-delivery action.
          const screenshotDetails = {
            ...(result as Record<string, unknown>),
            media: { outbound: false },
          };
          try {
            const described = await describeBrowserScreenshot(
              {
                cfg: screenshotCfg,
                filePath: screenshotPath,
                agentDir: opts?.agentDir,
                agentId: opts?.agentId,
                workspaceDir: opts?.workspaceDir,
                activeModel: opts?.activeModel,
                mediaScope: opts?.mediaScope,
                imageSanitization,
              },
              {
                describeImageFile: browserToolDeps.describeImageFile,
                normalizeBrowserScreenshot: browserToolDeps.normalizeBrowserScreenshot,
                saveMediaBuffer: browserToolDeps.saveMediaBuffer,
              },
            );
            if (described) {
              const analyzedBy =
                described.provider && described.model
                  ? `${described.provider}/${described.model}`
                  : "media image understanding";
              const headerLines = [`[analyzed by ${analyzedBy}]`];
              // Vision model descriptions contain web page content which is
              // untrusted external input — wrap it the same way snapshot and
              // tabs results are wrapped to mitigate prompt injection.
              const wrappedDescription = wrapExternalContent(
                neutralizeMediaDirectives(described.text.trim()),
                {
                  source: "browser",
                  includeWarning: true,
                },
              );
              const text = `${headerLines.join("\n")}\n${wrappedDescription}\n${shareHint}`;
              return {
                content: [{ type: "text", text }],
                details: {
                  ...(result as Record<string, unknown>),
                  // Do NOT include details.media here — the vision path returns
                  // a text description as the deliverable output. Exposing the raw
                  // screenshot as media would cause channel delivery to auto-send
                  // potentially sensitive page content. The text block carries the
                  // staged outbound-copy path for an explicit outbound-delivery send.
                  vision: {
                    provider: described.provider,
                    model: described.model,
                    decision: described.decision,
                  },
                },
              };
            }
          } catch (err) {
            // Fall back to returning the raw image block so the agent loop can
            // still recover. Provider/runtime errors are untrusted page input;
            // preserve their trust boundary and defang reply-media directives.
            const rawReason = err instanceof Error ? err.message : String(err);
            const reason = wrapExternalContent(neutralizeMediaDirectives(rawReason), {
              source: "browser",
              includeWarning: false,
            });
            const extraText = `[browser screenshot vision failed: ${reason}]\n${shareHint}`;
            return await browserToolDeps.imageResultFromFile({
              label: "browser:screenshot",
              path: screenshotPath,
              extraText,
              details: screenshotDetails,
              imageSanitization,
            });
          }
          return await browserToolDeps.imageResultFromFile({
            label: "browser:screenshot",
            path: screenshotPath,
            extraText: shareHint,
            details: screenshotDetails,
            imageSanitization,
          });
        }
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
            : await browserToolDeps.browserNavigate(baseUrl, {
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
        case "text":
        case "emulate": {
          const execute =
            action === "requests"
              ? executeRequestsAction
              : action === "text"
                ? executeTextAction
                : executeEmulateAction;
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
            : await browserToolDeps.browserPdfSave(baseUrl, { targetId, profile, signal });
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
            async () =>
              await browserToolDeps.browserArmFileChooser(baseUrl, { ...request, profile, signal }),
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
            async () =>
              await browserToolDeps.browserArmDialog(baseUrl, { ...request, profile, signal }),
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
        "act",
      ].includes(action) && actRequest?.kind !== "close"
        ? withBrowserTabDetails(result, targetId)
        : result;
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
