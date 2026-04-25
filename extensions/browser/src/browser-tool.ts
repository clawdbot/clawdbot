import crypto from "node:crypto";
import {
  executeActAction,
  executeConsoleAction,
  executeSnapshotAction,
  executeTabsAction,
} from "./browser-tool.actions.js";
import {
  type AnyAgentTool,
  type NodeListNode,
  DEFAULT_UPLOAD_DIR,
  BrowserToolSchema,
  applyBrowserProxyPaths,
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  browserProfiles,
  browserScreenshotAction,
  browserStart,
  browserStatus,
  browserStop,
  callGatewayTool,
  getBrowserProfileCapabilities,
  imageResultFromFile,
  jsonResult,
  listNodes,
  loadConfig,
  normalizeOptionalString,
  persistBrowserProxyFiles,
  readStringParam,
  readStringValue,
  resolveBrowserConfig,
  resolveExistingPathsWithinRoot,
  resolveNodeIdFromList,
  resolveProfile,
  selectDefaultNodeFromList,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser-tool.runtime.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "./browser/constants.js";

const browserToolDeps = {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserPdfSave,
  browserProfiles,
  browserScreenshotAction,
  browserStart,
  browserStatus,
  browserStop,
  imageResultFromFile,
  loadConfig,
  listNodes,
  callGatewayTool,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
};

export const __testing = {
  setDepsForTest(
    overrides: Partial<{
      browserAct: typeof browserAct;
      browserArmDialog: typeof browserArmDialog;
      browserArmFileChooser: typeof browserArmFileChooser;
      browserCloseTab: typeof browserCloseTab;
      browserDoctor: typeof browserDoctor;
      browserFocusTab: typeof browserFocusTab;
      browserNavigate: typeof browserNavigate;
      browserOpenTab: typeof browserOpenTab;
      browserPdfSave: typeof browserPdfSave;
      browserProfiles: typeof browserProfiles;
      browserScreenshotAction: typeof browserScreenshotAction;
      browserStart: typeof browserStart;
      browserStatus: typeof browserStatus;
      browserStop: typeof browserStop;
      imageResultFromFile: typeof imageResultFromFile;
      loadConfig: typeof loadConfig;
      listNodes: typeof listNodes;
      callGatewayTool: typeof callGatewayTool;
      touchSessionBrowserTab: typeof touchSessionBrowserTab;
      trackSessionBrowserTab: typeof trackSessionBrowserTab;
      untrackSessionBrowserTab: typeof untrackSessionBrowserTab;
    }> | null,
  ) {
    browserToolDeps.browserAct = overrides?.browserAct ?? browserAct;
    browserToolDeps.browserArmDialog = overrides?.browserArmDialog ?? browserArmDialog;
    browserToolDeps.browserArmFileChooser =
      overrides?.browserArmFileChooser ?? browserArmFileChooser;
    browserToolDeps.browserCloseTab = overrides?.browserCloseTab ?? browserCloseTab;
    browserToolDeps.browserDoctor = overrides?.browserDoctor ?? browserDoctor;
    browserToolDeps.browserFocusTab = overrides?.browserFocusTab ?? browserFocusTab;
    browserToolDeps.browserNavigate = overrides?.browserNavigate ?? browserNavigate;
    browserToolDeps.browserOpenTab = overrides?.browserOpenTab ?? browserOpenTab;
    browserToolDeps.browserPdfSave = overrides?.browserPdfSave ?? browserPdfSave;
    browserToolDeps.browserProfiles = overrides?.browserProfiles ?? browserProfiles;
    browserToolDeps.browserScreenshotAction =
      overrides?.browserScreenshotAction ?? browserScreenshotAction;
    browserToolDeps.browserStart = overrides?.browserStart ?? browserStart;
    browserToolDeps.browserStatus = overrides?.browserStatus ?? browserStatus;
    browserToolDeps.browserStop = overrides?.browserStop ?? browserStop;
    browserToolDeps.imageResultFromFile = overrides?.imageResultFromFile ?? imageResultFromFile;
    browserToolDeps.loadConfig = overrides?.loadConfig ?? loadConfig;
    browserToolDeps.listNodes = overrides?.listNodes ?? listNodes;
    browserToolDeps.callGatewayTool = overrides?.callGatewayTool ?? callGatewayTool;
    browserToolDeps.touchSessionBrowserTab =
      overrides?.touchSessionBrowserTab ?? touchSessionBrowserTab;
    browserToolDeps.trackSessionBrowserTab =
      overrides?.trackSessionBrowserTab ?? trackSessionBrowserTab;
    browserToolDeps.untrackSessionBrowserTab =
      overrides?.untrackSessionBrowserTab ?? untrackSessionBrowserTab;
  },
};

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = normalizeOptionalString(params.targetId);
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : undefined;
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  return (
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" })
  );
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
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

function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  if (requestParam && typeof requestParam === "object") {
    return requestParam as Parameters<typeof browserAct>[1];
  }

  const kind = readStringParam(params, "kind");
  if (!kind) {
    return undefined;
  }

  const request: Record<string, unknown> = { kind };
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    request[key] = params[key];
  }
  return request as Parameters<typeof browserAct>[1];
}

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5_000;

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
};

function isBrowserNode(node: NodeListNode) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null> {
  const cfg = browserToolDeps.loadConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }
  if (params.target && params.target !== "node") {
    return null;
  }
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const nodes = await browserToolDeps.listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
    const node = browserNodes.find((entry) => entry.nodeId === nodeId);
    return { nodeId, label: node?.displayName ?? node?.remoteIp ?? nodeId };
  }

  const selected = selectDefaultNodeFromList(browserNodes, {
    preferLocalMac: false,
    fallback: "none",
  });

  if (params.target === "node") {
    if (selected) {
      return {
        nodeId: selected.nodeId,
        label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
      };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") {
    return null;
  }

  if (selected) {
    return {
      nodeId: selected.nodeId,
      label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
    };
  }
  return null;
}

async function callBrowserProxy(params: {
  nodeId: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserProxyResult> {
  const proxyTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const gatewayTimeoutMs = proxyTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
  const payload = await browserToolDeps.callGatewayTool(
    "node.invoke",
    { timeoutMs: gatewayTimeoutMs },
    {
      nodeId: params.nodeId,
      command: "browser.proxy",
      params: {
        method: params.method,
        path: params.path,
        query: params.query,
        body: params.body,
        timeoutMs: proxyTimeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = loadConfig();
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

function shouldPreferHostForProfile(profileName: string | undefined) {
  if (!profileName) {
    return false;
  }
  const cfg = browserToolDeps.loadConfig();
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
  const cfg = browserToolDeps.loadConfig();
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
  return typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? Math.max(1, Math.floor(params.timeoutMs))
    : undefined;
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
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
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const profile = readStringParam(params, "profile");
      const requestedNode = readStringParam(params, "node");
      const requestedTimeoutMs = readToolTimeoutMs(params);
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;
      const configuredNode = browserToolDeps.loadConfig().gateway?.nodes?.browser?.node?.trim();

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
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
        nodeTarget = await resolveBrowserNodeTarget({
          requestedNode: requestedNode ?? undefined,
          target,
          sandboxBridgeUrl: opts?.sandboxBridgeUrl,
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

      const proxyRequest = nodeTarget
        ? async (opts: {
            method: string;
            path: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            timeoutMs?: number;
            profile?: string;
          }) => {
            const proxy = await callBrowserProxy({
              nodeId: nodeTarget.nodeId,
              method: opts.method,
              path: opts.path,
              query: opts.query,
              body: opts.body,
              timeoutMs: opts.timeoutMs,
              profile: opts.profile,
            });
            const mapping = await persistProxyFiles(proxy.files);
            applyProxyPaths(proxy.result, mapping);
            return proxy.result;
          }
        : null;
      const toolTimeoutMs =
        requestedTimeoutMs ??
        (usesExistingSessionManageFlow({ action, profileName: profile })
          ? DEFAULT_EXISTING_SESSION_MANAGE_TIMEOUT_MS
          : undefined);
      const touchTrackedTab = (targetId: string | undefined) => {
        if (proxyRequest || !targetId) {
          return;
        }
        browserToolDeps.touchSessionBrowserTab({
          sessionKey: opts?.agentSessionKey,
          targetId,
          baseUrl,
          profile,
        });
      };

      switch (action) {
        case "doctor":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/doctor",
                profile,
              }),
            );
          }
          return jsonResult(await browserToolDeps.browserDoctor(baseUrl, { profile }));
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
                timeoutMs: toolTimeoutMs,
              }),
            );
          }
          return jsonResult(
            await browserToolDeps.browserStatus(baseUrl, { profile, timeoutMs: toolTimeoutMs }),
          );
        case "start":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/start",
              profile,
              timeoutMs: toolTimeoutMs,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
                timeoutMs: toolTimeoutMs,
              }),
            );
          }
          await browserToolDeps.browserStart(baseUrl, { profile, timeoutMs: toolTimeoutMs });
          return jsonResult(
            await browserToolDeps.browserStatus(baseUrl, { profile, timeoutMs: toolTimeoutMs }),
          );
        case "stop":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/stop",
              profile,
              timeoutMs: toolTimeoutMs,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
                timeoutMs: toolTimeoutMs,
              }),
            );
          }
          await browserToolDeps.browserStop(baseUrl, { profile, timeoutMs: toolTimeoutMs });
          return jsonResult(
            await browserToolDeps.browserStatus(baseUrl, { profile, timeoutMs: toolTimeoutMs }),
          );
        case "profiles":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
              timeoutMs: toolTimeoutMs,
            });
            return jsonResult(result);
          }
          return jsonResult({
            profiles: await browserToolDeps.browserProfiles(baseUrl, { timeoutMs: toolTimeoutMs }),
          });
        case "tabs":
          return await executeTabsAction({
            baseUrl,
            profile,
            timeoutMs: toolTimeoutMs,
            proxyRequest,
          });
        case "open": {
          const targetUrl = readTargetUrlParam(params);
          const label = normalizeOptionalString(params.label);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/open",
              profile,
              body: { url: targetUrl, ...(label ? { label } : {}) },
              timeoutMs: toolTimeoutMs,
            });
            return jsonResult(result);
          }
          const opened = await browserToolDeps.browserOpenTab(baseUrl, targetUrl, {
            profile,
            label,
            timeoutMs: toolTimeoutMs,
          });
          browserToolDeps.trackSessionBrowserTab({
            sessionKey: opts?.agentSessionKey,
            targetId: opened.targetId,
            baseUrl,
            profile,
          });
          return jsonResult(opened);
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/focus",
              profile,
              body: { targetId },
              timeoutMs: toolTimeoutMs,
            });
            return jsonResult(result);
          }
          await browserToolDeps.browserFocusTab(baseUrl, targetId, {
            profile,
            timeoutMs: toolTimeoutMs,
          });
          touchTrackedTab(targetId);
          return jsonResult({ ok: true });
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
            return jsonResult(result);
          }
          if (targetId) {
            await browserToolDeps.browserCloseTab(baseUrl, targetId, {
              profile,
              timeoutMs: toolTimeoutMs,
            });
            browserToolDeps.untrackSessionBrowserTab({
              sessionKey: opts?.agentSessionKey,
              targetId,
              baseUrl,
              profile,
            });
          } else {
            await browserToolDeps.browserAct(
              baseUrl,
              { kind: "close" },
              {
                profile,
                timeoutMs: toolTimeoutMs,
              },
            );
          }
          return jsonResult({ ok: true });
        }
        case "snapshot":
          return await executeSnapshotAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
            onTabActivity: touchTrackedTab,
          });
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const labels = typeof params.labels === "boolean" ? params.labels : undefined;
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? Math.max(1, Math.floor(params.timeoutMs))
              : undefined;
          const effectiveTimeoutMs = timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
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
              });
          touchTrackedTab(readStringValue(result.targetId) ?? targetId);
          return await browserToolDeps.imageResultFromFile({
            label: "browser:screenshot",
            path: result.path,
            details: result,
          });
        }
        case "navigate": {
          const targetUrl = readTargetUrlParam(params);
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/navigate",
              profile,
              body: {
                url: targetUrl,
                targetId,
              },
            });
            return jsonResult(result);
          }
          const result = await browserToolDeps.browserNavigate(baseUrl, {
            url: targetUrl,
            targetId,
            profile,
          });
          touchTrackedTab(readStringValue(result.targetId) ?? targetId);
          return jsonResult(result);
        }
        case "console":
          return await executeConsoleAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
          });
        case "pdf": {
          const targetId = normalizeOptionalString(params.targetId);
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserToolDeps.browserPdfSave(baseUrl, { targetId, profile });
          touchTrackedTab(readStringValue(result.targetId) ?? targetId);
          return {
            content: [{ type: "text" as const, text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) {
            throw new Error("paths required");
          }
          const uploadPathsResult = await resolveExistingPathsWithinRoot({
            rootDir: DEFAULT_UPLOAD_DIR,
            requestedPaths: paths,
            scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
          });
          if (!uploadPathsResult.ok) {
            throw new Error(uploadPathsResult.error);
          }
          const normalizedPaths = uploadPathsResult.paths;
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/file-chooser",
              profile,
              body: {
                paths: normalizedPaths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          const result = await browserToolDeps.browserArmFileChooser(baseUrl, {
            paths: normalizedPaths,
            ref,
            inputRef,
            element,
            targetId,
            timeoutMs,
            profile,
          });
          touchTrackedTab(readStringValue((result as { targetId?: unknown }).targetId) ?? targetId);
          return jsonResult(result);
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = readStringValue(params.promptText);
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/dialog",
              profile,
              body: {
                accept,
                promptText,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          const result = await browserToolDeps.browserArmDialog(baseUrl, {
            accept,
            promptText,
            targetId,
            timeoutMs,
            profile,
          });
          touchTrackedTab(readStringValue((result as { targetId?: unknown }).targetId) ?? targetId);
          return jsonResult(result);
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
            onTabActivity: touchTrackedTab,
          });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
