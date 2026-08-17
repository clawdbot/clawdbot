/**
 * Agent-facing Canvas tool implementation for node canvas commands and
 * snapshots.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  imageResultFromFile,
  jsonResult,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { readFiniteNumberParam, readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { readRegularFile, wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/text-utility-runtime";
import { validateSupportedA2UIJsonl } from "./a2ui-jsonl.js";
import { normalizeCanvasSnapshotFileExtension, parseCanvasSnapshotPayload } from "./cli-helpers.js";
import { CanvasToolSchema } from "./tool-schema.js";

type CanvasToolOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentSessionKey?: string;
};

type CanvasImageSanitizationLimits = {
  maxDimensionPx?: number;
};

export const CANVAS_JSONL_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;
const CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS = 10_000;
const CANVAS_GATEWAY_PAYLOAD_BYTES = 25 * 1024 * 1024;
// The base64 field sits inside payloadJSON and the node.invoke response frame.
const CANVAS_GATEWAY_ENVELOPE_BYTES = 64 * 1024;
const CANVAS_MAX_BASE64_BYTES = CANVAS_GATEWAY_PAYLOAD_BYTES - CANVAS_GATEWAY_ENVELOPE_BYTES;
const CANVAS_SNAPSHOT_MAX_BYTES = Math.floor(CANVAS_MAX_BASE64_BYTES / 4) * 3;
const CANVAS_EVAL_TRUNCATION_MARKER = "\n[truncated — refine the Canvas eval expression]";

function readGatewayCallOptions(params: Record<string, unknown>) {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: readPositiveIntegerParam(params, "timeoutMs"),
  };
}

async function resolveNodeId(
  opts: ReturnType<typeof readGatewayCallOptions>,
  query?: string,
  allowDefault = false,
): Promise<string> {
  return resolveNodeIdFromList(await listNodes(opts), query, allowDefault);
}

function neutralizeCanvasMediaDirectives(value: string): string {
  return value.replace(/^([^\S\n]*)(MEDIA:)/gim, "$1[neutralized] $2");
}

async function removeCanvasSnapshotFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function serializeCanvasEvalResult(result: unknown): string {
  const json =
    typeof result === "string"
      ? neutralizeCanvasMediaDirectives(result)
      : JSON.stringify(result, (_key, value) =>
          typeof value === "string" ? neutralizeCanvasMediaDirectives(value) : value,
        );
  const serialized = json ?? neutralizeCanvasMediaDirectives(String(result));
  if (serialized.length <= DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS) {
    return serialized;
  }
  return `${truncateUtf16Safe(
    serialized,
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS - CANVAS_EVAL_TRUNCATION_MARKER.length,
  )}${CANVAS_EVAL_TRUNCATION_MARKER}`;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function readJsonlFromPath(jsonlPath: string, workspaceDir?: string): Promise<string> {
  const trimmed = jsonlPath.trim();
  if (!trimmed) {
    return "";
  }
  const workspaceRoot = path.resolve(workspaceDir ?? process.cwd());
  const resolved = path.resolve(workspaceRoot, trimmed);
  const [workspaceReal, resolvedReal] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(resolved),
  ]);
  if (!isPathInsideRoot(workspaceReal, resolvedReal)) {
    throw new Error("jsonlPath outside workspace");
  }
  return (
    await readRegularFile({ filePath: resolvedReal, maxBytes: CANVAS_JSONL_MAX_BYTES })
  ).buffer.toString("utf8");
}

function resolveCanvasImageSanitizationLimits(
  config?: OpenClawConfig,
): CanvasImageSanitizationLimits {
  const configured = config?.agents?.defaults?.imageMaxDimensionPx;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return {};
  }
  return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}

/** Creates the model-facing Canvas tool used to invoke paired node canvas commands. */
export function createCanvasTool(options?: CanvasToolOptions): AnyAgentTool {
  const imageSanitization = resolveCanvasImageSanitizationLimits(options?.config);
  return {
    label: "Canvas",
    name: "canvas",
    resultContentSource: "network",
    description:
      "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
    parameters: CanvasToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);
      const nodeQuery = readStringParam(params, "node", { trim: true });

      const invoke = async (command: string, invokeParams?: Record<string, unknown>) => {
        const nodeId = await resolveNodeId(gatewayOpts, nodeQuery, true);
        const timeoutMs =
          clampPositiveTimerTimeoutMs(
            gatewayOpts.timeoutMs ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
          ) ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS;
        // Preserve the node lookup budget while letting Gateway outlive node execution.
        const transportTimeoutMs =
          addTimerTimeoutGraceMs(timeoutMs, CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS) ?? timeoutMs;
        const result = await callGatewayTool(
          "node.invoke",
          { ...gatewayOpts, timeoutMs: transportTimeoutMs },
          {
            nodeId,
            command,
            params: invokeParams,
            timeoutMs,
            idempotencyKey: randomUUID(),
            ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
          },
        );
        return { node: nodeId, result };
      };

      switch (action) {
        case "present": {
          const placement = {
            x: readFiniteNumberParam(params, "x"),
            y: readFiniteNumberParam(params, "y"),
            width: readFiniteNumberParam(params, "width"),
            height: readFiniteNumberParam(params, "height"),
          };
          const invokeParams: Record<string, unknown> = {};
          const presentTarget =
            readStringParam(params, "target", { trim: true }) ??
            readStringParam(params, "url", { trim: true });
          if (presentTarget) {
            invokeParams.url = presentTarget;
          }
          if (
            Number.isFinite(placement.x) ||
            Number.isFinite(placement.y) ||
            Number.isFinite(placement.width) ||
            Number.isFinite(placement.height)
          ) {
            invokeParams.placement = placement;
          }
          const { node } = await invoke("canvas.present", invokeParams);
          return jsonResult({ ok: true, node, ...(presentTarget ? { url: presentTarget } : {}) });
        }
        case "hide": {
          const { node } = await invoke("canvas.hide", undefined);
          return jsonResult({ ok: true, node });
        }
        case "navigate": {
          const url =
            readStringParam(params, "url", { trim: true }) ??
            readStringParam(params, "target", { required: true, trim: true, label: "url" });
          const { node } = await invoke("canvas.navigate", { url });
          return jsonResult({ ok: true, node, url });
        }
        case "eval": {
          const javaScript = readStringParam(params, "javaScript", {
            required: true,
          });
          const { node, result: raw } = (await invoke("canvas.eval", { javaScript })) as {
            node: string;
            result?: { payload?: { result?: unknown } };
          };
          const result = raw?.payload?.result;
          const serialized = serializeCanvasEvalResult(result);
          // Remote Canvas pages must not forge prompt boundaries or outbound attachments.
          const text = serialized
            ? wrapExternalContent(serialized, { source: "browser", includeWarning: false })
            : serialized;
          return {
            content: [{ type: "text", text }],
            details: { ok: true, node, result },
          };
        }
        case "snapshot": {
          const formatRaw =
            typeof params.outputFormat === "string" && params.outputFormat.trim()
              ? params.outputFormat.trim().toLowerCase()
              : "png";
          const format = formatRaw === "jpg" || formatRaw === "jpeg" ? "jpeg" : "png";
          const maxWidth = readPositiveIntegerParam(params, "maxWidth");
          const quality = readFiniteNumberParam(params, "quality", {
            min: 0,
            max: 1,
          });
          const { node, result: raw } = (await invoke("canvas.snapshot", {
            format,
            maxWidth,
            quality,
          })) as { node: string; result?: { payload?: unknown } };
          const payload = parseCanvasSnapshotPayload(raw?.payload);
          const buffer = Buffer.from(payload.base64, "base64");
          const saved = await saveMediaBuffer(
            buffer,
            normalizeCanvasSnapshotFileExtension(payload.format) === "png"
              ? "image/png"
              : "image/jpeg",
            "canvas",
            CANVAS_SNAPSHOT_MAX_BYTES,
          );
          try {
            return await imageResultFromFile({
              label: "canvas:snapshot",
              path: saved.path,
              // Rendered pages are model observations, never automatic outbound attachments.
              details: { node, format: payload.format, media: { outbound: false } },
              imageSanitization,
            });
          } finally {
            // imageResultFromFile hydrates the model-visible image before returning.
            await removeCanvasSnapshotFile(saved.path);
          }
        }
        case "a2ui_push": {
          const jsonl =
            typeof params.jsonl === "string" && params.jsonl.trim()
              ? params.jsonl
              : typeof params.jsonlPath === "string" && params.jsonlPath.trim()
                ? await readJsonlFromPath(params.jsonlPath, options?.workspaceDir)
                : "";
          if (!jsonl.trim()) {
            throw new Error("jsonl or jsonlPath required");
          }
          validateSupportedA2UIJsonl(jsonl);
          const { node } = await invoke("canvas.a2ui.pushJSONL", { jsonl });
          return jsonResult({ ok: true, node });
        }
        case "a2ui_reset": {
          const { node } = await invoke("canvas.a2ui.reset", undefined);
          return jsonResult({ ok: true, node });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
