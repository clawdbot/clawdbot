import crypto from "node:crypto";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
} from "../../cli/nodes-camera.js";
import { parseEnvPairs, parseTimeoutMs } from "../../cli/nodes-run.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "../../cli/nodes-screen.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { imageMimeFromFormat } from "../../media/mime.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { resolveNodeId } from "./nodes-utils.js";

const NodesToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("status"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("describe"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("pending"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  }),
  Type.Object({
    action: Type.Literal("approve"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    requestId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("reject"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    requestId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("notify"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    sound: Type.Optional(Type.String()),
    priority: Type.Optional(
      Type.Union([
        Type.Literal("passive"),
        Type.Literal("active"),
        Type.Literal("timeSensitive"),
      ]),
    ),
    delivery: Type.Optional(
      Type.Union([
        Type.Literal("system"),
        Type.Literal("overlay"),
        Type.Literal("auto"),
      ]),
    ),
  }),
  Type.Object({
    action: Type.Literal("camera_snap"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    facing: Type.Optional(
      Type.Union([
        Type.Literal("front"),
        Type.Literal("back"),
        Type.Literal("both"),
      ]),
    ),
    maxWidth: Type.Optional(Type.Number()),
    quality: Type.Optional(Type.Number()),
    delayMs: Type.Optional(Type.Number()),
    deviceId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("camera_list"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("camera_clip"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    facing: Type.Optional(
      Type.Union([Type.Literal("front"), Type.Literal("back")]),
    ),
    duration: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Number()),
    includeAudio: Type.Optional(Type.Boolean()),
    deviceId: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("screen_record"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    duration: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Number()),
    fps: Type.Optional(Type.Number()),
    screenIndex: Type.Optional(Type.Number()),
    includeAudio: Type.Optional(Type.Boolean()),
    outPath: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("location_get"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    maxAgeMs: Type.Optional(Type.Number()),
    locationTimeoutMs: Type.Optional(Type.Number()),
    desiredAccuracy: Type.Optional(
      Type.Union([
        Type.Literal("coarse"),
        Type.Literal("balanced"),
        Type.Literal("precise"),
      ]),
    ),
  }),
  Type.Object({
    action: Type.Literal("run"),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    node: Type.String(),
    command: Type.Array(Type.String()),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Array(Type.String())),
    commandTimeoutMs: Type.Optional(Type.Number()),
    invokeTimeoutMs: Type.Optional(Type.Number()),
    needsScreenRecording: Type.Optional(Type.Boolean()),
  }),
]);

export function createNodesTool(): AnyAgentTool {
  return {
    label: "Nodes",
    name: "nodes",
    description:
      "Discover and control paired nodes (status/describe/pairing/notify/camera/screen/location/run).",
    parameters: NodesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs:
          typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      switch (action) {
        case "status":
          return jsonResult(
            await callGatewayTool("node.list", gatewayOpts, {}),
          );
        case "describe": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          return jsonResult(
            await callGatewayTool("node.describe", gatewayOpts, { nodeId }),
          );
        }
        case "pending":
          return jsonResult(
            await callGatewayTool("node.pair.list", gatewayOpts, {}),
          );
        case "approve": {
          const requestId = readStringParam(params, "requestId", {
            required: true,
          });
          return jsonResult(
            await callGatewayTool("node.pair.approve", gatewayOpts, {
              requestId,
            }),
          );
        }
        case "reject": {
          const requestId = readStringParam(params, "requestId", {
            required: true,
          });
          return jsonResult(
            await callGatewayTool("node.pair.reject", gatewayOpts, {
              requestId,
            }),
          );
        }
        case "notify": {
          const node = readStringParam(params, "node", { required: true });
          const title = typeof params.title === "string" ? params.title : "";
          const body = typeof params.body === "string" ? params.body : "";
          if (!title.trim() && !body.trim()) {
            throw new Error("title or body required");
          }
          const nodeId = await resolveNodeId(gatewayOpts, node);
          await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "system.notify",
            params: {
              title: title.trim() || undefined,
              body: body.trim() || undefined,
              sound:
                typeof params.sound === "string" ? params.sound : undefined,
              priority:
                typeof params.priority === "string"
                  ? params.priority
                  : undefined,
              delivery:
                typeof params.delivery === "string"
                  ? params.delivery
                  : undefined,
            },
            idempotencyKey: crypto.randomUUID(),
          });
          return jsonResult({ ok: true });
        }
        case "camera_snap": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const facingRaw =
            typeof params.facing === "string"
              ? params.facing.toLowerCase()
              : "both";
          const facings: CameraFacing[] =
            facingRaw === "both"
              ? ["front", "back"]
              : facingRaw === "front" || facingRaw === "back"
                ? [facingRaw]
                : (() => {
                    throw new Error("invalid facing (front|back|both)");
                  })();
          const maxWidth =
            typeof params.maxWidth === "number" &&
            Number.isFinite(params.maxWidth)
              ? params.maxWidth
              : undefined;
          const quality =
            typeof params.quality === "number" &&
            Number.isFinite(params.quality)
              ? params.quality
              : undefined;
          const delayMs =
            typeof params.delayMs === "number" &&
            Number.isFinite(params.delayMs)
              ? params.delayMs
              : undefined;
          const deviceId =
            typeof params.deviceId === "string" && params.deviceId.trim()
              ? params.deviceId.trim()
              : undefined;

          const content: AgentToolResult<unknown>["content"] = [];
          const details: Array<Record<string, unknown>> = [];

          for (const facing of facings) {
            const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
              nodeId,
              command: "camera.snap",
              params: {
                facing,
                maxWidth,
                quality,
                format: "jpg",
                delayMs,
                deviceId,
              },
              idempotencyKey: crypto.randomUUID(),
            })) as { payload?: unknown };
            const payload = parseCameraSnapPayload(raw?.payload);
            const normalizedFormat = payload.format.toLowerCase();
            if (
              normalizedFormat !== "jpg" &&
              normalizedFormat !== "jpeg" &&
              normalizedFormat !== "png"
            ) {
              throw new Error(
                `unsupported camera.snap format: ${payload.format}`,
              );
            }

            const isJpeg =
              normalizedFormat === "jpg" || normalizedFormat === "jpeg";
            const filePath = cameraTempPath({
              kind: "snap",
              facing,
              ext: isJpeg ? "jpg" : "png",
            });
            await writeBase64ToFile(filePath, payload.base64);
            content.push({ type: "text", text: `MEDIA:${filePath}` });
            content.push({
              type: "image",
              data: payload.base64,
              mimeType:
                imageMimeFromFormat(payload.format) ??
                (isJpeg ? "image/jpeg" : "image/png"),
            });
            details.push({
              facing,
              path: filePath,
              width: payload.width,
              height: payload.height,
            });
          }

          const result: AgentToolResult<unknown> = { content, details };
          return await sanitizeToolResultImages(result, "nodes:camera_snap");
        }
        case "camera_list": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "camera.list",
            params: {},
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          const payload =
            raw && typeof raw.payload === "object" && raw.payload !== null
              ? raw.payload
              : {};
          return jsonResult(payload);
        }
        case "camera_clip": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const facing =
            typeof params.facing === "string"
              ? params.facing.toLowerCase()
              : "front";
          if (facing !== "front" && facing !== "back") {
            throw new Error("invalid facing (front|back)");
          }
          const durationMs =
            typeof params.durationMs === "number" &&
            Number.isFinite(params.durationMs)
              ? params.durationMs
              : typeof params.duration === "string"
                ? parseDurationMs(params.duration)
                : 3000;
          const includeAudio =
            typeof params.includeAudio === "boolean"
              ? params.includeAudio
              : true;
          const deviceId =
            typeof params.deviceId === "string" && params.deviceId.trim()
              ? params.deviceId.trim()
              : undefined;
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "camera.clip",
            params: {
              facing,
              durationMs,
              includeAudio,
              format: "mp4",
              deviceId,
            },
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          const payload = parseCameraClipPayload(raw?.payload);
          const filePath = cameraTempPath({
            kind: "clip",
            facing,
            ext: payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);
          return {
            content: [{ type: "text", text: `FILE:${filePath}` }],
            details: {
              facing,
              path: filePath,
              durationMs: payload.durationMs,
              hasAudio: payload.hasAudio,
            },
          };
        }
        case "screen_record": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const durationMs =
            typeof params.durationMs === "number" &&
            Number.isFinite(params.durationMs)
              ? params.durationMs
              : typeof params.duration === "string"
                ? parseDurationMs(params.duration)
                : 10_000;
          const fps =
            typeof params.fps === "number" && Number.isFinite(params.fps)
              ? params.fps
              : 10;
          const screenIndex =
            typeof params.screenIndex === "number" &&
            Number.isFinite(params.screenIndex)
              ? params.screenIndex
              : 0;
          const includeAudio =
            typeof params.includeAudio === "boolean"
              ? params.includeAudio
              : true;
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "screen.record",
            params: {
              durationMs,
              screenIndex,
              fps,
              format: "mp4",
              includeAudio,
            },
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          const payload = parseScreenRecordPayload(raw?.payload);
          const filePath =
            typeof params.outPath === "string" && params.outPath.trim()
              ? params.outPath.trim()
              : screenRecordTempPath({ ext: payload.format || "mp4" });
          const written = await writeScreenRecordToFile(
            filePath,
            payload.base64,
          );
          return {
            content: [{ type: "text", text: `FILE:${written.path}` }],
            details: {
              path: written.path,
              durationMs: payload.durationMs,
              fps: payload.fps,
              screenIndex: payload.screenIndex,
              hasAudio: payload.hasAudio,
            },
          };
        }
        case "location_get": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const maxAgeMs =
            typeof params.maxAgeMs === "number" &&
            Number.isFinite(params.maxAgeMs)
              ? params.maxAgeMs
              : undefined;
          const desiredAccuracy =
            params.desiredAccuracy === "coarse" ||
            params.desiredAccuracy === "balanced" ||
            params.desiredAccuracy === "precise"
              ? params.desiredAccuracy
              : undefined;
          const locationTimeoutMs =
            typeof params.locationTimeoutMs === "number" &&
            Number.isFinite(params.locationTimeoutMs)
              ? params.locationTimeoutMs
              : undefined;
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "location.get",
            params: {
              maxAgeMs,
              desiredAccuracy,
              timeoutMs: locationTimeoutMs,
            },
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          return jsonResult(raw?.payload ?? {});
        }
        case "run": {
          const node = readStringParam(params, "node", { required: true });
          const nodeId = await resolveNodeId(gatewayOpts, node);
          const commandRaw = params.command;
          if (!commandRaw) {
            throw new Error(
              "command required (argv array, e.g. ['echo', 'Hello'])",
            );
          }
          if (!Array.isArray(commandRaw)) {
            throw new Error(
              "command must be an array of strings (argv), e.g. ['echo', 'Hello']",
            );
          }
          const command = commandRaw.map((c) => String(c));
          if (command.length === 0) {
            throw new Error("command must not be empty");
          }
          const cwd =
            typeof params.cwd === "string" && params.cwd.trim()
              ? params.cwd.trim()
              : undefined;
          const env = parseEnvPairs(params.env);
          const commandTimeoutMs = parseTimeoutMs(params.commandTimeoutMs);
          const invokeTimeoutMs = parseTimeoutMs(params.invokeTimeoutMs);
          const needsScreenRecording =
            typeof params.needsScreenRecording === "boolean"
              ? params.needsScreenRecording
              : undefined;
          const raw = (await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "system.run",
            params: {
              command,
              cwd,
              env,
              timeoutMs: commandTimeoutMs,
              needsScreenRecording,
            },
            timeoutMs: invokeTimeoutMs,
            idempotencyKey: crypto.randomUUID(),
          })) as { payload?: unknown };
          return jsonResult(raw?.payload ?? {});
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
