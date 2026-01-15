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
import { resolveBrowserConfig } from "../../browser/config.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import { loadConfig } from "../../config/config.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host" | "custom";
  controlUrl?: string;
  defaultControlUrl?: string;
  allowHostControl?: boolean;
  allowedControlUrls?: string[];
  allowedControlHosts?: string[];
  allowedControlPorts?: number[];
}) {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  const normalizedControlUrl = params.controlUrl?.trim() ?? "";
  const normalizedDefault = params.defaultControlUrl?.trim() ?? "";
  const target =
    params.target ?? (normalizedControlUrl ? "custom" : normalizedDefault ? "sandbox" : "host");

  const assertAllowedControlUrl = (url: string) => {
    const allowedUrls = params.allowedControlUrls?.map((entry) => entry.trim().replace(/\/$/, ""));
    const allowedHosts = params.allowedControlHosts?.map((entry) => entry.trim().toLowerCase());
    const allowedPorts = params.allowedControlPorts;
    if (!allowedUrls?.length && !allowedHosts?.length && !allowedPorts?.length) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid browser controlUrl: ${url}`);
    }
    const normalizedUrl = parsed.toString().replace(/\/$/, "");
    if (allowedUrls?.length && !allowedUrls.includes(normalizedUrl)) {
      throw new Error("Browser controlUrl is not in the allowed URL list.");
    }
    if (allowedHosts?.length && !allowedHosts.includes(parsed.hostname)) {
      throw new Error("Browser controlUrl hostname is not in the allowed host list.");
    }
    if (allowedPorts?.length) {
      const port =
        parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      if (!Number.isFinite(port) || !allowedPorts.includes(port)) {
        throw new Error("Browser controlUrl port is not in the allowed port list.");
      }
    }
  };

  if (target !== "custom" && params.target && normalizedControlUrl) {
    throw new Error('controlUrl is only supported with target="custom".');
  }

  if (target === "custom") {
    if (!normalizedControlUrl) {
      throw new Error("Custom browser target requires controlUrl.");
    }
    const normalized = normalizedControlUrl.replace(/\/$/, "");
    assertAllowedControlUrl(normalized);
    return normalized;
  }

  if (target === "sandbox") {
    if (!normalizedDefault) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedDefault.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.clawdbot/clawdbot.json.",
    );
  }
  const normalized = resolved.controlUrl.replace(/\/$/, "");
  assertAllowedControlUrl(normalized);
  return normalized;
}

export function createBrowserTool(opts?: {
  defaultControlUrl?: string;
  allowHostControl?: boolean;
  allowedControlUrls?: string[];
  allowedControlHosts?: string[];
  allowedControlPorts?: number[];
}): AnyAgentTool {
  const targetDefault = opts?.defaultControlUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  const allowlistHint =
    opts?.allowedControlUrls?.length ||
    opts?.allowedControlHosts?.length ||
    opts?.allowedControlPorts?.length
      ? "Custom targets are restricted by sandbox allowlists."
      : "Custom targets are unrestricted.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via Clawdbot's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
      'Profiles: use profile="chrome" for Chrome extension relay takeover (your existing Chrome tabs). Use profile="clawd" for the isolated clawd-managed browser.',
      'If the user mentions the Chrome extension / Browser Relay / toolbar button / “attach tab”, ALWAYS use profile="chrome" (do not ask which profile).',
      "Chrome extension relay needs an attached tab: user must click the Clawdbot Browser Relay toolbar icon on the tab (badge ON). If no tab is connected, ask them to attach it.",
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc).",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      `target selects browser location (sandbox|host|custom). Default: ${targetDefault}.`,
      "controlUrl implies target=custom (remote control server).",
      hostHint,
      allowlistHint,
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const controlUrl = readStringParam(params, "controlUrl");
      const profile = readStringParam(params, "profile");
      let target = readStringParam(params, "target") as "sandbox" | "host" | "custom" | undefined;
      if (profile === "chrome" && !target && !controlUrl?.trim()) {
        // Chrome extension relay takeover is a host Chrome feature; default to host even in sandboxed sessions.
        target = "host";
      }
      const baseUrl = resolveBrowserBaseUrl({
        target,
        controlUrl,
        defaultControlUrl: opts?.defaultControlUrl,
        allowHostControl: opts?.allowHostControl,
        allowedControlUrls: opts?.allowedControlUrls,
        allowedControlHosts: opts?.allowedControlHosts,
        allowedControlPorts: opts?.allowedControlPorts,
      });

      switch (action) {
        case "status":
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "start":
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "profiles":
          return jsonResult({ profiles: await browserProfiles(baseUrl) });
        case "tabs":
          return jsonResult({ tabs: await browserTabs(baseUrl, { profile }) });
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          return jsonResult(await browserOpenTab(baseUrl, targetUrl, { profile }));
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          await browserFocusTab(baseUrl, targetId, { profile });
          return jsonResult({ ok: true });
        }
        case "close": {
          const targetId = readStringParam(params, "targetId");
          if (targetId) await browserCloseTab(baseUrl, targetId, { profile });
          else await browserAct(baseUrl, { kind: "close" }, { profile });
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const format =
            params.format === "ai" || params.format === "aria"
              ? (params.format as "ai" | "aria")
              : "ai";
          const mode = params.mode === "efficient" ? "efficient" : undefined;
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
          const snapshot = await browserSnapshot(baseUrl, {
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
          const result = await browserScreenshotAction(baseUrl, {
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
          return jsonResult(await browserConsoleMessages(baseUrl, { level, targetId, profile }));
        }
        case "pdf": {
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const result = await browserPdfSave(baseUrl, { targetId, profile });
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
            const result = await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
              profile,
            });
            return jsonResult(result);
          } catch (err) {
            const msg = String(err);
            if (msg.includes("404:") && msg.includes("tab not found") && profile === "chrome") {
              const tabs = await browserTabs(baseUrl, { profile }).catch(() => []);
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
