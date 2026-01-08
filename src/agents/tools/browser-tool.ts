import { Type } from "@sinclair/typebox";

import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
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
import { loadConfig } from "../../config/config.js";
import {
  type AnyAgentTool,
  imageResultFromFile,
  jsonResult,
  readStringParam,
} from "./common.js";

const BROWSER_ACT_KINDS = [
  "click",
  "type",
  "press",
  "hover",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
] as const;

type BrowserActKind = (typeof BROWSER_ACT_KINDS)[number];

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (kind) determines which properties are relevant; runtime validates.
const BrowserActSchema = Type.Object({
  kind: Type.Unsafe<BrowserActKind>({
    type: "string",
    enum: [...BROWSER_ACT_KINDS],
  }),
  // Common fields
  targetId: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  // click
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String())),
  // type
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  // press
  key: Type.Optional(Type.String()),
  // drag
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  // select
  values: Type.Optional(Type.Array(Type.String())),
  // fill - use permissive array of objects
  fields: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true })),
  ),
  // resize
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  // wait
  timeMs: Type.Optional(Type.Number()),
  textGone: Type.Optional(Type.String()),
  // evaluate
  fn: Type.Optional(Type.String()),
});

// IMPORTANT: OpenAI function tool schemas must have a top-level `type: "object"`.
// A root-level `Type.Union([...])` compiles to `{ anyOf: [...] }` (no `type`),
// which OpenAI rejects ("Invalid schema ... type: None"). Keep this schema an object.
const BrowserToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("start"),
    Type.Literal("stop"),
    Type.Literal("tabs"),
    Type.Literal("open"),
    Type.Literal("focus"),
    Type.Literal("close"),
    Type.Literal("snapshot"),
    Type.Literal("screenshot"),
    Type.Literal("navigate"),
    Type.Literal("console"),
    Type.Literal("pdf"),
    Type.Literal("upload"),
    Type.Literal("dialog"),
    Type.Literal("act"),
  ]),
  profile: Type.Optional(Type.String()),
  controlUrl: Type.Optional(Type.String()),
  targetUrl: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  format: Type.Optional(Type.Union([Type.Literal("aria"), Type.Literal("ai")])),
  fullPage: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Type.String()),
  element: Type.Optional(Type.String()),
  type: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
  level: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
  inputRef: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  accept: Type.Optional(Type.Boolean()),
  promptText: Type.Optional(Type.String()),
  request: Type.Optional(BrowserActSchema),
});

function resolveBrowserBaseUrl(controlUrl?: string) {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  if (!resolved.enabled && !controlUrl?.trim()) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.clawdbot/clawdbot.json.",
    );
  }
  const url = controlUrl?.trim() ? controlUrl.trim() : resolved.controlUrl;
  return url.replace(/\/$/, "");
}

export function createBrowserTool(opts?: {
  defaultControlUrl?: string;
}): AnyAgentTool {
  return {
    label: "Browser",
    name: "browser",
    description:
      "Control clawd's dedicated browser (status/start/stop/tabs/open/snapshot/screenshot/actions). Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const controlUrl = readStringParam(params, "controlUrl");
      const profile = readStringParam(params, "profile");
      const baseUrl = resolveBrowserBaseUrl(
        controlUrl ?? opts?.defaultControlUrl,
      );

      switch (action) {
        case "status":
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "start":
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "tabs":
          return jsonResult({ tabs: await browserTabs(baseUrl, { profile }) });
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          return jsonResult(
            await browserOpenTab(baseUrl, targetUrl, { profile }),
          );
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
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? params.limit
              : undefined;
          const snapshot = await browserSnapshot(baseUrl, {
            format,
            targetId,
            limit,
            profile,
          });
          if (snapshot.format === "ai") {
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
          const level =
            typeof params.level === "string" ? params.level.trim() : undefined;
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          return jsonResult(
            await browserConsoleMessages(baseUrl, { level, targetId, profile }),
          );
        }
        case "pdf": {
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const result = await browserPdfSave(baseUrl, { targetId, profile });
          return {
            content: [{ type: "text", text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths)
            ? params.paths.map((p) => String(p))
            : [];
          if (paths.length === 0) throw new Error("paths required");
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" &&
            Number.isFinite(params.timeoutMs)
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
          const promptText =
            typeof params.promptText === "string"
              ? params.promptText
              : undefined;
          const targetId =
            typeof params.targetId === "string"
              ? params.targetId.trim()
              : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" &&
            Number.isFinite(params.timeoutMs)
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
          const result = await browserAct(
            baseUrl,
            request as Parameters<typeof browserAct>[1],
            { profile },
          );
          return jsonResult(result);
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
