import fs from "node:fs/promises";
import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { writeBase64ToFile } from "../nodes-camera.js";
import { canvasSnapshotTempPath, parseCanvasSnapshotPayload } from "../nodes-canvas.js";
import { parseTimeoutMs } from "../nodes-run.js";
import { buildA2UITextJsonl, validateA2UIJsonl } from "./a2ui-jsonl.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";
import { shortenHomePath } from "../../utils.js";

async function invokeCanvas(opts: NodesRpcOpts, command: string, params?: Record<string, unknown>) {
  const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
  const invokeParams: Record<string, unknown> = {
    nodeId,
    command,
    params,
    idempotencyKey: randomIdempotencyKey(),
  };
  const timeoutMs = parseTimeoutMs(opts.invokeTimeout);
  if (typeof timeoutMs === "number") {
    invokeParams.timeoutMs = timeoutMs;
  }
  return await callGatewayCli("node.invoke", opts, invokeParams);
}

export function registerNodesCanvasCommands(nodes: Command) {
  const canvas = nodes
    .command("canvas")
    .description("Capture or render canvas content from a paired node");

  nodesCallOpts(
    canvas
      .command("snapshot")
      .description("Capture a canvas snapshot (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--format <png|jpg|jpeg>", "Image format", "jpg")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (optional)")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("canvas snapshot", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const formatOpt = String(opts.format ?? "jpg")
            .trim()
            .toLowerCase();
          const formatForParams =
            formatOpt === "jpg" ? "jpeg" : formatOpt === "jpeg" ? "jpeg" : "png";
          if (formatForParams !== "png" && formatForParams !== "jpeg") {
            throw new Error(`invalid format: ${String(opts.format)} (expected png|jpg|jpeg)`);
          }

          const maxWidth = opts.maxWidth ? Number.parseInt(String(opts.maxWidth), 10) : undefined;
          const quality = opts.quality ? Number.parseFloat(String(opts.quality)) : undefined;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "canvas.snapshot",
            params: {
              format: formatForParams,
              maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
              quality: Number.isFinite(quality) ? quality : undefined,
            },
            idempotencyKey: randomIdempotencyKey(),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const raw = (await callGatewayCli("node.invoke", opts, invokeParams)) as unknown;
          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload = parseCanvasSnapshotPayload(res.payload);
          const filePath = canvasSnapshotTempPath({
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify({ file: { path: filePath, format: payload.format } }, null, 2),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${shortenHomePath(filePath)}`);
        });
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    canvas
      .command("present")
      .description("Show the canvas (optionally with a target URL/path)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--target <urlOrPath>", "Target URL/path (optional)")
      .option("--x <px>", "Placement x coordinate")
      .option("--y <px>", "Placement y coordinate")
      .option("--width <px>", "Placement width")
      .option("--height <px>", "Placement height")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("canvas present", async () => {
          const placement = {
            x: opts.x ? Number.parseFloat(opts.x) : undefined,
            y: opts.y ? Number.parseFloat(opts.y) : undefined,
            width: opts.width ? Number.parseFloat(opts.width) : undefined,
            height: opts.height ? Number.parseFloat(opts.height) : undefined,
          };
          const params: Record<string, unknown> = {};
          if (opts.target) params.url = String(opts.target);
          if (
            Number.isFinite(placement.x) ||
            Number.isFinite(placement.y) ||
            Number.isFinite(placement.width) ||
            Number.isFinite(placement.height)
          ) {
            params.placement = placement;
          }
          await invokeCanvas(opts, "canvas.present", params);
          if (!opts.json) {
            const { ok } = getNodesTheme();
            defaultRuntime.log(ok("canvas present ok"));
          }
        });
      }),
  );

  nodesCallOpts(
    canvas
      .command("hide")
      .description("Hide the canvas")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("canvas hide", async () => {
          await invokeCanvas(opts, "canvas.hide", undefined);
          if (!opts.json) {
            const { ok } = getNodesTheme();
            defaultRuntime.log(ok("canvas hide ok"));
          }
        });
      }),
  );

  nodesCallOpts(
    canvas
      .command("navigate")
      .description("Navigate the canvas to a URL")
      .argument("<url>", "Target URL/path")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (url: string, opts: NodesRpcOpts) => {
        await runNodesCommand("canvas navigate", async () => {
          await invokeCanvas(opts, "canvas.navigate", { url });
          if (!opts.json) {
            const { ok } = getNodesTheme();
            defaultRuntime.log(ok("canvas navigate ok"));
          }
        });
      }),
  );

  nodesCallOpts(
    canvas
      .command("eval")
      .description("Evaluate JavaScript in the canvas")
      .argument("[js]", "JavaScript to evaluate")
      .option("--js <code>", "JavaScript to evaluate")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (jsArg: string | undefined, opts: NodesRpcOpts) => {
        await runNodesCommand("canvas eval", async () => {
          const js = opts.js ?? jsArg;
          if (!js) throw new Error("missing --js or <js>");
          const raw = await invokeCanvas(opts, "canvas.eval", {
            javaScript: js,
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(raw, null, 2));
            return;
          }
          const payload =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: { result?: string } }).payload
              : undefined;
          if (payload?.result) defaultRuntime.log(payload.result);
          else {
            const { ok } = getNodesTheme();
            defaultRuntime.log(ok("canvas eval ok"));
          }
        });
      }),
  );

  const a2ui = canvas.command("a2ui").description("Render A2UI content on the canvas");

  nodesCallOpts(
    a2ui
      .command("push")
      .description("Push A2UI JSONL to the canvas")
      .option("--jsonl <path>", "Path to JSONL payload")
      .option("--text <text>", "Render a quick A2UI text payload")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("canvas a2ui push", async () => {
          const hasJsonl = Boolean(opts.jsonl);
          const hasText = typeof opts.text === "string";
          if (hasJsonl === hasText) {
            throw new Error("provide exactly one of --jsonl or --text");
          }

          const jsonl = hasText
            ? buildA2UITextJsonl(String(opts.text ?? ""))
            : await fs.readFile(String(opts.jsonl), "utf8");
          const { version, messageCount } = validateA2UIJsonl(jsonl);
          if (version === "v0.9") {
            throw new Error(
              "Detected A2UI v0.9 JSONL (createSurface). Moltbot currently supports v0.8 only.",
            );
          }
          await invokeCanvas(opts, "canvas.a2ui.pushJSONL", { jsonl });
          if (!opts.json) {
            const { ok } = getNodesTheme();
            defaultRuntime.log(
              ok(
                `canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`,
              ),
            );
          }
        });
      }),
  );

  nodesCallOpts(
    a2ui
      .command("reset")
      .description("Reset A2UI renderer state")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("canvas a2ui reset", async () => {
          await invokeCanvas(opts, "canvas.a2ui.reset", undefined);
          if (!opts.json) {
            const { ok } = getNodesTheme();
            defaultRuntime.log(ok("canvas a2ui reset ok"));
          }
        });
      }),
  );
}
