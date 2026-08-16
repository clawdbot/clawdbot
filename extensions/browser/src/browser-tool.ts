/**
 * Browser agent tool registration.
 *
 * Builds the model-facing browser tool, chooses sandbox/host/node routing, and
 * maps high-level actions onto browser control client calls.
 */
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createBrowserNodeProxyRequest } from "./browser-node-proxy.js";
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
  executeTabsAction,
  formatBrowserExternalToolResult,
} from "./browser-tool.actions.js";
import {
  type AnyAgentTool,
  BrowserToolOutputSchema,
  BrowserToolSchema,
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
  return `[Screenshot saved to ${JSON.stringify(filePath)}. Use this path with the message tool to share the screenshot explicitly.]`;
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
    nodes: await browserToolDeps.listNodes({}),
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

/**
 * Read importable system profiles from the host control server. Discovery must
 * match where import runs (host-local), so it never uses a node proxy or the
 * sandbox base URL. Returns [] when host control is unavailable.
 */
async function readHostSystemProfiles(params: {
  allowHostControl?: boolean;
  sandboxBridgeUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  if (params.allowHostControl === false) {
    return [];
  }
  let hostBaseUrl: string | undefined;
  try {
    hostBaseUrl = resolveBrowserBaseUrl({
      target: "host",
      sandboxBridgeUrl: params.sandboxBridgeUrl,
      allowHostControl: params.allowHostControl,
    });
  } catch {
    return [];
  }
  return await browserToolDeps
    .browserSystemProfiles(hostBaseUrl, { timeoutMs: params.timeoutMs, signal: params.signal })
    .catch(() => {
      params.signal?.throwIfAborted();
      return [];
    });
}

function shouldPreferHostForProfile(profileName: string | undefined) {
  if (!profileName) {
    return false;
  }
  const cfg = browserToolDeps.getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, profileName);
  if (!profile) {
    return false;
  }
  const capabilities = getBrowserProfileCapabilities(profile);
  return capabilities.usesChromeMcp;
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

function usesExistingSessionManageFlow(params: { action: string; profileName?: string }) {
  if (!EXISTING_SESSION_MANAGE_ACTIONS.has(params.action)) {
    return false;
  }
  const cfg = browserToolDeps.getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, params.profileName ?? resolved.defaultProfile);
  if (profile && getBrowserProfileCapabilities(profile).usesChromeMcp) {
    return true;
  }
  if (params.action !== "profiles") {
    return false;
  }
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
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserTool({ targetDefault, hostHint }),
    parameters: BrowserToolSchema,
    outputSchema: BrowserToolOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const bindingResult =
        opts?.runToolBinding === undefined
          ? undefined
          : parseBrowserTabToolBinding(opts.runToolBinding);
      if (bindingResult && !bindingResult.ok) {
        throw new Error(`invalid browser run binding: ${bindingResult.error}`);
      }
      const params = bindingResult?.ok
        ? applyBrowserTabToolBinding(args as Record<string, unknown>, bindingResult.binding)
        : (args as Record<string, unknown>);
      const action = readStringParam(params, "action", { required: true });
      const profile = readStringParam(params, "profile");
      const requestedNode = readStringParam(params, "node");
      const requestedTimeoutMs = readToolTimeoutMs(params);
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;
      const runtimeConfig = browserToolDeps.getRuntimeConfig();
      const resolvedBrowser = resolveBrowserConfig(runtimeConfig.browser, runtimeConfig);
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
      const isUserBrowserProfile = shouldPreferHostForProfile(profile);
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
        });
      } catch (error) {
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
      const toolTimeoutMs =
        requestedTimeoutMs ??
        (usesExistingSessionManageFlow({ action, profileName: profile })
          ? DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS
          : undefined);
      const sessionTabs = createBrowserToolSessionTabs({
        sessionKey: opts?.agentSessionKey,
        requestedProfile: profile,
        defaultProfile: resolvedBrowser.defaultProfile,
        baseUrl,
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
          const systemProfiles = await readHostSystemProfiles({
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
            });
          }
          return jsonResult({
            profiles: await browserToolDeps.browserProfiles(baseUrl, {
              timeoutMs: toolTimeoutMs,
              signal,
            }),
            systemProfiles,
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
          return jsonResult(proxyRequest ? result : { ok: true });
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
          if (targetId) {
            await browserToolDeps.browserCloseTab(baseUrl, targetId, {
              profile,
              timeoutMs: toolTimeoutMs,
              signal,
            });
            sessionTabs.untrack(targetId);
          } else {
            const result = await browserToolDeps.browserAct(
              baseUrl,
              { kind: "close" },
              {
                profile,
                timeoutMs: toolTimeoutMs,
                signal,
              },
            );
            sessionTabs.untrack(readStringValue(result.targetId));
          }
          return jsonResult({ ok: true });
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
          // delivery must remain an explicit message-tool action.
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
                  // staged outbound-copy path for an explicit message-tool send.
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
          return await executeActAction({
            request,
            baseUrl,
            profile,
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
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
