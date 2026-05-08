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
  optionalStringEnum,
  readStringParam,
  stringEnum,
} from "openclaw/plugin-sdk/channel-actions";
import type { AnyAgentTool, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { Type } from "typebox";

const CANVAS_ACTIONS = [
  "present",
  "hide",
  "navigate",
  "eval",
  "snapshot",
  "a2ui_push",
  "a2ui_reset",
] as const;

const CANVAS_SNAPSHOT_FORMATS = ["png", "jpg", "jpeg"] as const;

type CanvasToolOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
};

type CanvasSnapshotPayload = {
  format: string;
  base64: string;
};

type CanvasImageSanitizationLimits = {
  maxDimensionPx?: number;
};

function readGatewayCallOptions(params: Record<string, unknown>) {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
  };
}

async function resolveNodeId(
  opts: ReturnType<typeof readGatewayCallOptions>,
  query?: string,
  allowDefault = false,
): Promise<string> {
  return resolveNodeIdFromList(await listNodes(opts), query, allowDefault);
}

function parseCanvasSnapshotPayload(value: unknown): CanvasSnapshotPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid canvas.snapshot payload");
  }
  const record = value as Record<string, unknown>;
  const format = typeof record.format === "string" ? record.format : "";
  const base64 = typeof record.base64 === "string" ? record.base64 : "";
  if (!format || !base64) {
    throw new Error("invalid canvas.snapshot payload");
  }
  return { format, base64 };
}

async function writeBase64ToTempFile(params: { base64: string; ext: string }): Promise<string> {
  const dir = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const ext = params.ext.startsWith(".") ? params.ext : `.${params.ext}`;
  const filePath = path.join(dir, `openclaw-canvas-snapshot-${randomUUID()}${ext}`);
  await fs.writeFile(filePath, Buffer.from(params.base64, "base64"));
  return filePath;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
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
  return await fs.readFile(resolvedReal, "utf8");
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

// Flattened schema: runtime validates per-action requirements.
const CanvasToolSchema = Type.Object({
  action: stringEnum(CANVAS_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  url: Type.Optional(Type.String()),
  javaScript: Type.Optional(Type.String()),
  outputFormat: optionalStringEnum(CANVAS_SNAPSHOT_FORMATS),
  maxWidth: Type.Optional(Type.Number()),
  quality: Type.Optional(Type.Number()),
  delayMs: Type.Optional(Type.Number()),
  jsonl: Type.Optional(Type.String()),
  jsonlPath: Type.Optional(Type.String()),
});

export function createCanvasTool(options?: CanvasToolOptions): AnyAgentTool {
  const imageSanitization = resolveCanvasImageSanitizationLimits(options?.config);
  return {
    label: "Canvas",
    name: "canvas",
    description:
      "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
    parameters: CanvasToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts = readGatewayCallOptions(params);

      const nodeId = await resolveNodeId(
        gatewayOpts,
        readStringParam(params, "node", { trim: true }),
        true,
      );

      const invoke = async (command: string, invokeParams?: Record<string, unknown>) =>
        await callGatewayTool("node.invoke", gatewayOpts, {
          nodeId,
          command,
          params: invokeParams,
          idempotencyKey: randomUUID(),
        });

      switch (action) {
        case "present": {
          const placement = {
            x: typeof params.x === "number" ? params.x : undefined,
            y: typeof params.y === "number" ? params.y : undefined,
            width: typeof params.width === "number" ? params.width : undefined,
            height: typeof params.height === "number" ? params.height : undefined,
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
          await invoke("canvas.present", invokeParams);
          return jsonResult({ ok: true });
        }
        case "hide":
          await invoke("canvas.hide", undefined);
          return jsonResult({ ok: true });
        case "navigate": {
          const url =
            readStringParam(params, "url", { trim: true }) ??
            readStringParam(params, "target", { required: true, trim: true, label: "url" });
          await invoke("canvas.navigate", { url });
          return jsonResult({ ok: true });
        }
        case "eval": {
          const javaScript = readStringParam(params, "javaScript", {
            required: true,
          });
          const raw = (await invoke("canvas.eval", { javaScript })) as {
            payload?: { result?: string };
          };
          const result = raw?.payload?.result;
          if (result) {
            return {
              content: [{ type: "text", text: result }],
              details: { result },
            };
          }
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const formatRaw =
            typeof params.outputFormat === "string" && params.outputFormat.trim()
              ? params.outputFormat.trim().toLowerCase()
              : "png";
          const format = formatRaw === "jpg" || formatRaw === "jpeg" ? "jpeg" : "png";
          const maxWidth =
            typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth)
              ? params.maxWidth
              : undefined;
          const quality =
            typeof params.quality === "number" && Number.isFinite(params.quality)
              ? params.quality
              : undefined;
          const raw = (await invoke("canvas.snapshot", {
            format,
            maxWidth,
            quality,
          })) as { payload?: unknown };
          const payload = parseCanvasSnapshotPayload(raw?.payload);
          const filePath = await writeBase64ToTempFile({
            base64: payload.base64,
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          return await imageResultFromFile({
            label: "canvas:snapshot",
            path: filePath,
            details: { format: payload.format },
            imageSanitization,
          });
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
          await invoke("canvas.a2ui.pushJSONL", { jsonl });
          return jsonResult({ ok: true });
        }
        case "a2ui_reset":
          await invoke("canvas.a2ui.reset", undefined);
          return jsonResult({ ok: true });
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
