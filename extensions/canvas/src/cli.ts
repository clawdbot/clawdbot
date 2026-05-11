import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Command } from "commander";
import { runCommandWithRuntime, theme } from "openclaw/plugin-sdk/cli-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  callGatewayFromCli,
  resolveNodeFromNodeList,
  type NodeMatchCandidate,
} from "openclaw/plugin-sdk/gateway-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildA2UITextJsonl, validateA2UIJsonl } from "./a2ui-jsonl.js";
import { canvasSnapshotTempPath, parseCanvasSnapshotPayload } from "./cli-helpers.js";

export type CanvasCliRuntime = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
  writeJson: (value: unknown) => void;
};

export type CanvasNodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  invokeTimeout?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  js?: string;
  jsonl?: string;
  text?: string;
  format?: string;
  maxWidth?: string;
  quality?: string;
};

export type CanvasCliDependencies = {
  defaultRuntime: CanvasCliRuntime;
  nodesCallOpts: (cmd: Command, defaults?: { timeoutMs?: number }) => Command;
  runNodesCommand: (label: string, action: () => Promise<void>) => Promise<void> | void;
  getNodesTheme: () => { ok: (value: string) => string };
  parseTimeoutMs: (raw: unknown) => number | undefined;
  resolveNodeId: (opts: CanvasNodesRpcOpts, query: string) => Promise<string>;
  buildNodeInvokeParams: (params: {
    nodeId: string;
    command: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Record<string, unknown>;
  callGatewayCli: (
    method: string,
    opts: CanvasNodesRpcOpts,
    params?: unknown,
    callOpts?: { transportTimeoutMs?: number },
  ) => Promise<unknown>;
  writeBase64ToFile: (filePath: string, base64: string) => Promise<unknown>;
  shortenHomePath: (filePath: string) => string;
};

type CanvasNodeCandidate = NodeMatchCandidate;

function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value =
    typeof raw === "number" || typeof raw === "bigint"
      ? Number(raw)
      : typeof raw === "string" && raw.trim()
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function parseNodeCandidates(raw: unknown): CanvasNodeCandidate[] {
  const payload =
    raw && typeof raw === "object" ? (raw as { nodes?: unknown; paired?: unknown }) : {};
  const list = Array.isArray(payload.nodes)
    ? payload.nodes
    : Array.isArray(payload.paired)
      ? payload.paired
      : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const node = entry as {
        nodeId?: unknown;
        displayName?: unknown;
        remoteIp?: unknown;
        connected?: unknown;
        clientId?: unknown;
      };
      if (typeof node.nodeId !== "string") {
        return null;
      }
      const candidate: CanvasNodeCandidate = { nodeId: node.nodeId };
      if (typeof node.displayName === "string") {
        candidate.displayName = node.displayName;
      }
      if (typeof node.remoteIp === "string") {
        candidate.remoteIp = node.remoteIp;
      }
      if (typeof node.connected === "boolean") {
        candidate.connected = node.connected;
      }
      if (typeof node.clientId === "string") {
        candidate.clientId = node.clientId;
      }
      return candidate;
    })
    .filter((entry): entry is CanvasNodeCandidate => entry !== null);
}

function unauthorizedHintForMessage(message: string): string | null {
  const haystack = normalizeLowercaseStringOrEmpty(message);
  if (
    haystack.includes("unauthorizedclient") ||
    haystack.includes("bridge client is not authorized") ||
    haystack.includes("unsigned bridge clients are not allowed")
  ) {
    return [
      "peekaboo bridge rejected the client.",
      "sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
      "PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev.",
    ].join(" ");
  }
  return null;
}

export function createDefaultCanvasCliDependencies(): CanvasCliDependencies {
  const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
    cmd
      .option(
        "--url <url>",
        "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
      )
      .option("--token <token>", "Gateway token (if required)")
      .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
      .option("--json", "Output JSON", false);
  const callGatewayCli: CanvasCliDependencies["callGatewayCli"] = async (
    method,
    opts,
    params,
    callOpts,
  ) => {
    const timeout = String(callOpts?.transportTimeoutMs ?? opts.timeout ?? 10_000);
    return await callGatewayFromCli(method, { ...opts, timeout }, params, {
      progress: opts.json !== true,
    });
  };
  return {
    defaultRuntime,
    nodesCallOpts,
    runNodesCommand: (label, action) =>
      runCommandWithRuntime(defaultRuntime, action, (err) => {
        const message = formatErrorMessage(err);
        defaultRuntime.error(theme.error(`nodes ${label} failed: ${message}`));
        const hint = unauthorizedHintForMessage(message);
        if (hint) {
          defaultRuntime.error(theme.warn(hint));
        }
        defaultRuntime.exit(1);
      }),
    getNodesTheme: () => ({ ok: theme.success }),
    parseTimeoutMs,
    resolveNodeId: async (opts, query) => {
      let raw: unknown;
      try {
        raw = await callGatewayCli("node.list", opts, {});
      } catch {
        raw = await callGatewayCli("node.pair.list", opts, {});
      }
      return resolveNodeFromNodeList(parseNodeCandidates(raw), query).nodeId;
    },
    buildNodeInvokeParams: ({ nodeId, command, params, timeoutMs }) => ({
      nodeId,
      command,
      params,
      idempotencyKey: randomUUID(),
      ...(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    }),
    callGatewayCli,
    writeBase64ToFile: async (filePath, base64) =>
      await fs.writeFile(filePath, Buffer.from(base64, "base64")),
    shortenHomePath,
  };
}

async function invokeCanvas(
  deps: CanvasCliDependencies,
  opts: CanvasNodesRpcOpts,
  command: string,
  params?: Record<string, unknown>,
) {
  const nodeId = await deps.resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
  const timeoutMs = deps.parseTimeoutMs(opts.invokeTimeout);
  return await deps.callGatewayCli(
    "node.invoke",
    opts,
    deps.buildNodeInvokeParams({
      nodeId,
      command,
      params,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
    }),
  );
}

export function registerNodesCanvasCommands(nodes: Command, deps: CanvasCliDependencies) {
  const canvas = nodes
    .command("canvas")
    .description("Capture or render canvas content from a paired node");

  deps.nodesCallOpts(
    canvas
      .command("snapshot")
      .description("Capture a canvas snapshot (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--format <png|jpg|jpeg>", "Image format", "jpg")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (optional)")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000")
      .action(async (opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas snapshot", async () => {
          const formatOpt = normalizeLowercaseStringOrEmpty(
            normalizeOptionalString(opts.format) ?? "jpg",
          );
          const formatForParams =
            formatOpt === "jpg" ? "jpeg" : formatOpt === "jpeg" ? "jpeg" : "png";
          if (formatForParams !== "png" && formatForParams !== "jpeg") {
            throw new Error(`invalid format: ${String(opts.format)} (expected png|jpg|jpeg)`);
          }

          const maxWidth = opts.maxWidth ? Number.parseInt(opts.maxWidth, 10) : undefined;
          const quality = opts.quality ? Number.parseFloat(opts.quality) : undefined;
          const raw = await invokeCanvas(deps, opts, "canvas.snapshot", {
            format: formatForParams,
            maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
            quality: Number.isFinite(quality) ? quality : undefined,
          });
          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const payload = parseCanvasSnapshotPayload(res.payload);
          const filePath = canvasSnapshotTempPath({
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          await deps.writeBase64ToFile(filePath, payload.base64);

          if (opts.json) {
            deps.defaultRuntime.writeJson({ file: { path: filePath, format: payload.format } });
            return;
          }
          deps.defaultRuntime.log(`MEDIA:${deps.shortenHomePath(filePath)}`);
        });
      }),
    { timeoutMs: 60_000 },
  );

  deps.nodesCallOpts(
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
      .action(async (opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas present", async () => {
          const placement = {
            x: opts.x ? Number.parseFloat(opts.x) : undefined,
            y: opts.y ? Number.parseFloat(opts.y) : undefined,
            width: opts.width ? Number.parseFloat(opts.width) : undefined,
            height: opts.height ? Number.parseFloat(opts.height) : undefined,
          };
          const params: Record<string, unknown> = {};
          if (opts.target) {
            params.url = opts.target;
          }
          if (
            Number.isFinite(placement.x) ||
            Number.isFinite(placement.y) ||
            Number.isFinite(placement.width) ||
            Number.isFinite(placement.height)
          ) {
            params.placement = placement;
          }
          await invokeCanvas(deps, opts, "canvas.present", params);
          if (!opts.json) {
            const { ok } = deps.getNodesTheme();
            deps.defaultRuntime.log(ok("canvas present ok"));
          }
        });
      }),
  );

  deps.nodesCallOpts(
    canvas
      .command("hide")
      .description("Hide the canvas")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas hide", async () => {
          await invokeCanvas(deps, opts, "canvas.hide", undefined);
          if (!opts.json) {
            const { ok } = deps.getNodesTheme();
            deps.defaultRuntime.log(ok("canvas hide ok"));
          }
        });
      }),
  );

  deps.nodesCallOpts(
    canvas
      .command("navigate")
      .description("Navigate the canvas to a URL")
      .argument("<url>", "Target URL/path")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (url: string, opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas navigate", async () => {
          await invokeCanvas(deps, opts, "canvas.navigate", { url });
          if (!opts.json) {
            const { ok } = deps.getNodesTheme();
            deps.defaultRuntime.log(ok("canvas navigate ok"));
          }
        });
      }),
  );

  deps.nodesCallOpts(
    canvas
      .command("eval")
      .description("Evaluate JavaScript in the canvas")
      .argument("[js]", "JavaScript to evaluate")
      .option("--js <code>", "JavaScript to evaluate")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (jsArg: string | undefined, opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas eval", async () => {
          const js = opts.js ?? jsArg;
          if (!js) {
            throw new Error("missing --js or <js>");
          }
          const raw = await invokeCanvas(deps, opts, "canvas.eval", {
            javaScript: js,
          });
          if (opts.json) {
            deps.defaultRuntime.writeJson(raw);
            return;
          }
          const payload =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: { result?: string } }).payload
              : undefined;
          if (payload?.result) {
            deps.defaultRuntime.log(payload.result);
          } else {
            const { ok } = deps.getNodesTheme();
            deps.defaultRuntime.log(ok("canvas eval ok"));
          }
        });
      }),
  );

  const a2ui = canvas.command("a2ui").description("Render A2UI content on the canvas");

  deps.nodesCallOpts(
    a2ui
      .command("push")
      .description("Push A2UI JSONL to the canvas")
      .option("--jsonl <path>", "Path to JSONL payload")
      .option("--text <text>", "Render a quick A2UI text payload")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas a2ui push", async () => {
          const hasJsonl = Boolean(opts.jsonl);
          const hasText = typeof opts.text === "string";
          if (hasJsonl === hasText) {
            throw new Error("provide exactly one of --jsonl or --text");
          }

          const jsonl = hasText
            ? buildA2UITextJsonl(opts.text ?? "")
            : await fs.readFile(String(opts.jsonl), "utf8");
          const { version, messageCount } = validateA2UIJsonl(jsonl);
          if (version === "v0.9") {
            throw new Error(
              "Detected A2UI v0.9 JSONL (createSurface). OpenClaw currently supports v0.8 only.",
            );
          }
          await invokeCanvas(deps, opts, "canvas.a2ui.pushJSONL", { jsonl });
          if (!opts.json) {
            const { ok } = deps.getNodesTheme();
            deps.defaultRuntime.log(
              ok(
                `canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`,
              ),
            );
          }
        });
      }),
  );

  deps.nodesCallOpts(
    a2ui
      .command("reset")
      .description("Reset A2UI renderer state")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: CanvasNodesRpcOpts) => {
        await deps.runNodesCommand("canvas a2ui reset", async () => {
          await invokeCanvas(deps, opts, "canvas.a2ui.reset", undefined);
          if (!opts.json) {
            const { ok } = deps.getNodesTheme();
            deps.defaultRuntime.log(ok("canvas a2ui reset ok"));
          }
        });
      }),
  );
}
