import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "../../browser/client.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "../../browser/client-actions.js";
import crypto from "node:crypto";

import { resolveBrowserConfig } from "../../browser/config.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import { loadConfig } from "../../config/config.js";
import { saveMediaBuffer } from "../../media/store.js";
import { listNodes, resolveNodeIdFromList, type NodeListNode } from "./nodes-utils.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

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
  const cfg = loadConfig();
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
  if (params.target && params.target !== "node") return null;
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const nodes = await listNodes({});
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

  if (params.target === "node") {
    if (browserNodes.length === 1) {
      const node = browserNodes[0]!;
      return { nodeId: node.nodeId, label: node.displayName ?? node.remoteIp ?? node.nodeId };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") return null;

  if (browserNodes.length === 1) {
    const node = browserNodes[0]!;
    return { nodeId: node.nodeId, label: node.displayName ?? node.remoteIp ?? node.nodeId };
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
  const gatewayTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const payload = (await callGatewayTool(
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
        timeoutMs: params.timeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  )) as {
    ok?: boolean;
    payload?: BrowserProxyResult;
    payloadJSON?: string | null;
  };
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  if (!files || files.length === 0) return new Map<string, string>();
  const mapping = new Map<string, string>();
  for (const file of files) {
    const buffer = Buffer.from(file.base64, "base64");
    const saved = await saveMediaBuffer(buffer, file.mimeType, "browser", buffer.byteLength);
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  if (!result || typeof result !== "object") return;
  const obj = result as Record<string, unknown>;
  if (typeof obj.path === "string" && mapping.has(obj.path)) {
    obj.path = mapping.get(obj.path);
  }
  if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
    obj.imagePath = mapping.get(obj.imagePath);
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const d = download as Record<string, unknown>;
    if (typeof d.path === "string" && mapping.has(d.path)) {
      d.path = mapping.get(d.path);
    }
  }
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
      "Browser control is disabled. Set browser.enabled=true in ~/.clawdbot/clawdbot.json.",
    );
  }
  return undefined;
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via Clawdbot's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
      'Profiles: use profile="chrome" for Chrome extension relay takeover (your existing Chrome tabs). Use profile="clawd" for the isolated clawd-managed browser.',
      'If the user mentions the Chrome extension / Browser Relay / toolbar button / “attach tab”, ALWAYS use profile="chrome" (do not ask which profile).',
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      "Chrome extension relay needs an attached tab: user must click the Clawdbot Browser Relay toolbar icon on the tab (badge ON). If no tab is connected, ask them to attach it.",
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc).",
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
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }

      if (!target && !requestedNode && profile === "chrome") {
        // Chrome extension relay takeover is a host Chrome feature; prefer host unless explicitly targeting a node.
        target = "host";
      }

      const nodeTarget = await resolveBrowserNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });

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

      switch (action) {
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "start":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/start",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/stop",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "profiles":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
            });
            return jsonResult(result);
          }
          return jsonResult({ profiles: await browserProfiles(baseUrl) });
        case "tabs":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            });
            const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
            return jsonResult({ tabs });
          }
          return jsonResult({ tabs: await browserTabs(baseUrl, { profile }) });
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/open",
              profile,
              body: { url: targetUrl },
            });
            return jsonResult(result);
          }
          return jsonResult(await browserOpenTab(baseUrl, targetUrl, { profile }));
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
            });
            return jsonResult(result);
          }
          await browserFocusTab(baseUrl, targetId, { profile });
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
                })
              : await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: { kind: "close" },
                });
            return jsonResult(result);
          }
          if (targetId) await browserCloseTab(baseUrl, targetId, { profile });
          else await browserAct(baseUrl, { kind: "close" }, { profile });
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const snapshotDefaults = loadConfig().browser?.snapshotDefaults;
          const format =
            params.snapshotFormat === "ai" || params.snapshotFormat === "aria"
              ? (params.snapshotFormat as "ai" | "aria")
              : "ai";
          const mode =
            params.mode === "efficient"
              ? "efficient"
              : format === "ai" && snapshotDefaults?.mode === "efficient"
                ? "efficient"
                : undefined;
          const labels = typeof params.labels === "boolean" ? params.labels : undefined;
          const refs = params.refs === "aria" || params.refs === "role" ? params.refs : undefined;
          const hasMaxChars = Object.hasOwn(params, "maxChars");
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? params.limit
              : undefined;
          const maxChars =
            typeof params.maxChars === "number" &&
            Number.isFinite(params.maxChars) &&
            params.maxChars > 0
              ? Math.floor(params.maxChars)
              : undefined;
          const resolvedMaxChars =
            format === "ai"
              ? hasMaxChars
                ? maxChars
                : mode === "efficient"
                  ? undefined
                  : DEFAULT_AI_SNAPSHOT_MAX_CHARS
              : undefined;
          const interactive =
            typeof params.interactive === "boolean" ? params.interactive : undefined;
          const compact = typeof params.compact === "boolean" ? params.compact : undefined;
          const depth =
            typeof params.depth === "number" && Number.isFinite(params.depth)
              ? params.depth
              : undefined;
          const selector = typeof params.selector === "string" ? params.selector.trim() : undefined;
          const frame = typeof params.frame === "string" ? params.frame.trim() : undefined;
          const snapshot = proxyRequest
            ? ((await proxyRequest({
                method: "GET",
                path: "/snapshot",
                profile,
                query: {
                  format,
                  targetId,
                  limit,
                  ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                  refs,
                  interactive,
                  compact,
                  depth,
                  selector,
                  frame,
                  labels,
                  mode,
                },
              })) as Awaited<ReturnType<typeof browserSnapshot>>)
            : await browserSnapshot(baseUrl, {
                format,
                targetId,
                limit,
                ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                refs,
                interactive,
                compact,
                depth,
                selector,
                frame,
                labels,
                mode,
                profile,
              });
          if (snapshot.format === "ai") {
            if (labels && snapshot.imagePath) {
              return await imageResultFromFile({
                label: "browser:snapshot",
                path: snapshot.imagePath,
                extraText: snapshot.snapshot,
                details: snapshot,
              });
            }
            return {
              content: [{ type: "text", text: snapshot.snapshot }],
              details: snapshot,
            };
          }
          return jsonResult(snapshot);
        }
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                profile,
              });
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: result.path,
            details: result,
          });
        }
        case "navigate": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
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
          return jsonResult(
            await browserNavigate(baseUrl, {
              url: targetUrl,
              targetId,
              profile,
            }),
          );
        }
        case "console": {
          const level = typeof params.level === "string" ? params.level.trim() : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/console",
              profile,
              query: {
                level,
                targetId,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(await browserConsoleMessages(baseUrl, { level, targetId, profile }));
        }
        case "pdf": {
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserPdfSave(baseUrl, { targetId, profile });
          return {
            content: [{ type: "text", text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) throw new Error("paths required");
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/file-chooser",
              profile,
              body: {
                paths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmFileChooser(baseUrl, {
              paths,
              ref,
              inputRef,
              element,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = typeof params.promptText === "string" ? params.promptText : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
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
          return jsonResult(
            await browserArmDialog(baseUrl, {
              accept,
              promptText,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "act": {
          const request = params.request as Record<string, unknown> | undefined;
          if (!request || typeof request !== "object") {
            throw new Error("request required");
          }
          try {
            const result = proxyRequest
              ? await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: request,
                })
              : await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
                  profile,
                });
            return jsonResult(result);
          } catch (err) {
            const msg = String(err);
            if (msg.includes("404:") && msg.includes("tab not found") && profile === "chrome") {
              const tabs = proxyRequest
                ? ((
                    (await proxyRequest({
                      method: "GET",
                      path: "/tabs",
                      profile,
                    })) as { tabs?: unknown[] }
                  ).tabs ?? [])
                : await browserTabs(baseUrl, { profile }).catch(() => []);
              if (!tabs.length) {
                throw new Error(
                  "No Chrome tabs are attached via the Clawdbot Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
                );
              }
              throw new Error(
                `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome" and use one of the returned targetIds.`,
              );
            }
            throw err;
          }
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
