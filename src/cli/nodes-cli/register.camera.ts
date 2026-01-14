import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
} from "../nodes-camera.js";
import { parseDurationMs } from "../parse-duration.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

const parseFacing = (value: string): CameraFacing => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "front" || v === "back") return v;
  throw new Error(`invalid facing: ${value} (expected front|back)`);
};

export function registerNodesCameraCommands(nodes: Command) {
  const camera = nodes
    .command("camera")
    .description("Capture camera media from a paired node");

  nodesCallOpts(
    camera
      .command("list")
      .description("List available cameras on a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const raw = (await callGatewayCli("node.invoke", opts, {
            nodeId,
            command: "camera.list",
            params: {},
            idempotencyKey: randomIdempotencyKey(),
          })) as unknown;

          const res =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: unknown })
              : {};
          const payload =
            typeof res.payload === "object" && res.payload !== null
              ? (res.payload as { devices?: unknown })
              : {};
          const devices = Array.isArray(payload.devices) ? payload.devices : [];

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(devices, null, 2));
            return;
          }

          if (devices.length === 0) {
            defaultRuntime.log("No cameras reported.");
            return;
          }

          for (const device of devices) {
            const id = typeof device.id === "string" ? device.id : "";
            const name =
              typeof device.name === "string" ? device.name : "Unknown Camera";
            const position =
              typeof device.position === "string"
                ? device.position
                : "unspecified";
            defaultRuntime.log(`${name} (${position})${id ? ` — ${id}` : ""}`);
          }
        } catch (err) {
          defaultRuntime.error(`nodes camera list failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
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
      .option(
        "--delay-ms <ms>",
        "Delay before capture in ms (macOS default 2000)",
      )
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 20000)",
        "20000",
      )
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const facingOpt = String(opts.facing ?? "both")
            .trim()
            .toLowerCase();
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

          const maxWidth = opts.maxWidth
            ? Number.parseInt(String(opts.maxWidth), 10)
            : undefined;
          const quality = opts.quality
            ? Number.parseFloat(String(opts.quality))
            : undefined;
          const delayMs = opts.delayMs
            ? Number.parseInt(String(opts.delayMs), 10)
            : undefined;
          const deviceId = opts.deviceId
            ? String(opts.deviceId).trim()
            : undefined;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const results: Array<{
            facing: CameraFacing;
            path: string;
            width: number;
            height: number;
          }> = [];

          for (const facing of facings) {
            const invokeParams: Record<string, unknown> = {
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
              idempotencyKey: randomIdempotencyKey(),
            };
            if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
              invokeParams.timeoutMs = timeoutMs;
            }

            const raw = (await callGatewayCli(
              "node.invoke",
              opts,
              invokeParams,
            )) as unknown;
            const res =
              typeof raw === "object" && raw !== null
                ? (raw as { payload?: unknown })
                : {};
            const payload = parseCameraSnapPayload(res.payload);
            const filePath = cameraTempPath({
              kind: "snap",
              facing,
              ext: payload.format === "jpeg" ? "jpg" : payload.format,
            });
            await writeBase64ToFile(filePath, payload.base64);
            results.push({
              facing,
              path: filePath,
              width: payload.width,
              height: payload.height,
            });
          }

          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ files: results }, null, 2));
            return;
          }
          defaultRuntime.log(results.map((r) => `MEDIA:${r.path}`).join("\n"));
        } catch (err) {
          defaultRuntime.error(`nodes camera snap failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("clip")
      .description(
        "Capture a short video clip from a node camera (prints MEDIA:<path>)",
      )
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back>", "Camera facing", "front")
      .option("--device-id <id>", "Camera device id (from nodes camera list)")
      .option(
        "--duration <ms|10s|1m>",
        "Duration (default 3000ms; supports ms/s/m, e.g. 10s)",
        "3000",
      )
      .option("--no-audio", "Disable audio capture")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 90000)",
        "90000",
      )
      .action(async (opts: NodesRpcOpts & { audio?: boolean }) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const facing = parseFacing(String(opts.facing ?? "front"));
          const durationMs = parseDurationMs(String(opts.duration ?? "3000"));
          const includeAudio = opts.audio !== false;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;
          const deviceId = opts.deviceId
            ? String(opts.deviceId).trim()
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "camera.clip",
            params: {
              facing,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              includeAudio,
              format: "mp4",
              deviceId: deviceId || undefined,
            },
            idempotencyKey: randomIdempotencyKey(),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const raw = (await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          )) as unknown;
          const res =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: unknown })
              : {};
          const payload = parseCameraClipPayload(res.payload);
          const filePath = cameraTempPath({
            kind: "clip",
            facing,
            ext: payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    facing,
                    path: filePath,
                    durationMs: payload.durationMs,
                    hasAudio: payload.hasAudio,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${filePath}`);
        } catch (err) {
          defaultRuntime.error(`nodes camera clip failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 90_000 },
  );
}
