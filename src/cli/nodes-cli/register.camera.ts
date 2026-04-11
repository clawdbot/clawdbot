import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { shortenHomePath } from "../../utils.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeCameraPayloadToFile,
  writeCameraClipPayloadToFile,
} from "../nodes-camera.js";
import { parseDurationMs } from "../parse-duration.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import {
  buildNodeInvokeParams,
  callGatewayCli,
  nodesCallOpts,
  resolveNode,
  resolveNodeId,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

const parseFacing = (value: string): CameraFacing => {
  const v = normalizeLowercaseStringOrEmpty(normalizeOptionalString(value) ?? "");
  if (v === "front" || v === "back") {
    return v;
  }
  throw new Error(`invalid facing: ${value} (expected front|back)`);
};

function getGatewayInvokePayload(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null
    ? (raw as { payload?: unknown }).payload
    : undefined;
}

export function registerNodesCameraCommands(nodes: Command) {
  const camera = nodes.command("camera").description("Capture camera media from a paired node");

  nodesCallOpts(
    camera
      .command("list")
      .description("List available cameras on a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("camera list", async () => {
          const nodeId = await resolveNodeId(opts, opts.node ?? "");
          const raw = await callGatewayCli(
            "node.invoke",
            opts,
            buildNodeInvokeParams({
              nodeId,
              command: "camera.list",
              params: {},
            }),
          );

          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload =
            typeof res.payload === "object" && res.payload !== null
              ? (res.payload as { devices?: unknown })
              : {};
          const devices = Array.isArray(payload.devices) ? payload.devices : [];

          if (opts.json) {
            defaultRuntime.writeJson(devices);
            return;
          }

          if (devices.length === 0) {
            const { muted } = getNodesTheme();
            defaultRuntime.log(muted("No cameras reported."));
            return;
          }

          const { heading, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const rows = devices.map((device) => ({
            Name: typeof device.name === "string" ? device.name : "Unknown Camera",
            Position: typeof device.position === "string" ? device.position : muted("unspecified"),
            ID: typeof device.id === "string" ? device.id : "",
          }));
          defaultRuntime.log(heading("Cameras"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Name", header: "Name", minWidth: 14, flex: true },
                { key: "Position", header: "Position", minWidth: 10 },
                { key: "ID", header: "ID", minWidth: 10, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("snap")
      .description("Capture a photo from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back|both>", "Camera facing", "both")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (default 0.9)")
      .option("--delay-ms <ms>", "Delay before capture in ms (macOS default 2000)")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("camera snap", async () => {
          const node = await resolveNode(opts, normalizeOptionalString(opts.node) ?? "");
          const nodeId = node.nodeId;
          const facingOpt = normalizeLowercaseStringOrEmpty(
            normalizeOptionalString(opts.facing) ?? "both",
          );
          const facings: CameraFacing[] =
            facingOpt === "both"
              ? ["front", "back"]
              : facingOpt === "front" || facingOpt === "back"
                ? [facingOpt]
                : (() => {
                    throw new Error(
                      `invalid facing: ${String(opts.facing)} (expected front|back|both)`,
                    );
                  })();

          const maxWidth = opts.maxWidth ? Number.parseInt(opts.maxWidth, 10) : undefined;
          const quality = opts.quality ? Number.parseFloat(opts.quality) : undefined;
          const delayMs = opts.delayMs ? Number.parseInt(opts.delayMs, 10) : undefined;
          const deviceId = normalizeOptionalString(opts.deviceId);
          if (deviceId && facings.length > 1) {
            throw new Error("facing=both is not allowed when --device-id is set");
          }
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(opts.invokeTimeout, 10)
            : undefined;

          const results: Array<{
            facing: CameraFacing;
            path: string;
            width: number;
            height: number;
          }> = [];

          for (const facing of facings) {
            const invokeParams = buildNodeInvokeParams({
              nodeId,
              command: "camera.snap",
              params: {
                facing,
                maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
                quality: Number.isFinite(quality) ? quality : undefined,
                format: "jpg",
                delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
                deviceId: deviceId || undefined,
              },
              timeoutMs,
            });

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const payload = parseCameraSnapPayload(getGatewayInvokePayload(raw));
            const filePath = cameraTempPath({
              kind: "snap",
              facing,
              ext: payload.format === "jpeg" ? "jpg" : payload.format,
            });
            await writeCameraPayloadToFile({
              filePath,
              payload,
              expectedHost: node.remoteIp,
              invalidPayloadMessage: "invalid camera.snap payload",
            });
            results.push({
              facing,
              path: filePath,
              width: payload.width,
              height: payload.height,
            });
          }

          if (opts.json) {
            defaultRuntime.writeJson({ files: results });
            return;
          }
          defaultRuntime.log(results.map((r) => `MEDIA:${shortenHomePath(r.path)}`).join("\n"));
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("clip")
      .description("Capture a short video clip from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back>", "Camera facing", "front")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option(
        "--duration <ms|10s|1m>",
        "Duration (default 3000ms; supports ms/s/m, e.g. 10s)",
        "3000",
      )
      .option("--no-audio", "Disable audio capture")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 90000)", "90000")
      .action(async (opts: NodesRpcOpts & { audio?: boolean }) => {
        await runNodesCommand("camera clip", async () => {
          const node = await resolveNode(opts, normalizeOptionalString(opts.node) ?? "");
          const nodeId = node.nodeId;
          const facing = parseFacing(opts.facing ?? "front");
          const durationMs = parseDurationMs(opts.duration ?? "3000");
          const includeAudio = opts.audio !== false;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(opts.invokeTimeout, 10)
            : undefined;
          const deviceId = normalizeOptionalString(opts.deviceId);

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command: "camera.clip",
            params: {
              facing,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              includeAudio,
              format: "mp4",
              deviceId: deviceId || undefined,
            },
            timeoutMs,
          });

          const raw = await callGatewayCli("node.invoke", opts, invokeParams);
          const payload = parseCameraClipPayload(getGatewayInvokePayload(raw));
          const filePath = await writeCameraClipPayloadToFile({
            payload,
            facing,
            expectedHost: node.remoteIp,
          });

          if (opts.json) {
            defaultRuntime.writeJson({
              file: {
                facing,
                path: filePath,
                durationMs: payload.durationMs,
                hasAudio: payload.hasAudio,
              },
            });
            return;
          }
          defaultRuntime.log(`MEDIA:${shortenHomePath(filePath)}`);
        });
      }),
    { timeoutMs: 90_000 },
  );
}
