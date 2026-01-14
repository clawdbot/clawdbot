import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "../nodes-screen.js";
import { parseDurationMs } from "../parse-duration.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesScreenCommands(nodes: Command) {
  const screen = nodes
    .command("screen")
    .description("Capture screen recordings from a paired node");

  nodesCallOpts(
    screen
      .command("record")
      .description(
        "Capture a short screen recording from a node (prints MEDIA:<path>)",
      )
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--duration <ms|10s>", "Clip duration (ms or 10s)", "10000")
      .option("--fps <fps>", "Frames per second", "10")
      .option("--no-audio", "Disable microphone audio capture")
      .option("--out <path>", "Output path")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 120000)",
        "120000",
      )
      .action(async (opts: NodesRpcOpts & { out?: string }) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const durationMs = parseDurationMs(opts.duration ?? "");
          const screenIndex = Number.parseInt(String(opts.screen ?? "0"), 10);
          const fps = Number.parseFloat(String(opts.fps ?? "10"));
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "screen.record",
            params: {
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              screenIndex: Number.isFinite(screenIndex)
                ? screenIndex
                : undefined,
              fps: Number.isFinite(fps) ? fps : undefined,
              format: "mp4",
              includeAudio: opts.audio !== false,
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
          const parsed = parseScreenRecordPayload(res.payload);
          const filePath =
            opts.out ?? screenRecordTempPath({ ext: parsed.format || "mp4" });
          const written = await writeScreenRecordToFile(
            filePath,
            parsed.base64,
          );

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    path: written.path,
                    durationMs: parsed.durationMs,
                    fps: parsed.fps,
                    screenIndex: parsed.screenIndex,
                    hasAudio: parsed.hasAudio,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${written.path}`);
        } catch (err) {
          defaultRuntime.error(`nodes screen record failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 180_000 },
  );
}
