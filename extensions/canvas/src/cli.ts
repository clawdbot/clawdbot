/**
 * Canvas node CLI command registration and runtime dependency wiring.
 */
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { runCommandWithRuntime, theme } from "openclaw/plugin-sdk/cli-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  callGatewayFromCli,
  isGatewayClientRequestError,
  resolveNodeFromNodeList,
  type NodeMatchCandidate,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  parseStrictFiniteNumber,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/** Runtime output surface used by Canvas CLI commands. */
type CanvasCliRuntime = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
  writeJson: (value: unknown) => void;
};

/** Parent node/gateway options consumed by Canvas CLI commands. */
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
};

/** Dependency bundle used to keep Canvas CLI commands testable. */
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
};

type CanvasNodeCandidate = NodeMatchCandidate;

const DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS = 30_000;
const CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS = 10_000;

function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error("--invoke-timeout must be a positive integer.");
  }
  return parsed;
}

function parseCanvasFiniteNumberOption(raw: string | undefined, flag: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(raw);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a number.`);
  }
  return parsed;
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

/** Creates the default Canvas CLI dependency bundle backed by the OpenClaw gateway CLI. */
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
      } catch (error) {
        if (
          !isGatewayClientRequestError(error) ||
          error.gatewayCode !== "INVALID_REQUEST" ||
          error.retryable ||
          error.message !== "unknown method: node.list"
        ) {
          throw error;
        }
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
  };
}

async function invokeCanvas(
  deps: CanvasCliDependencies,
  opts: CanvasNodesRpcOpts,
  command: string,
  params?: Record<string, unknown>,
) {
  const timeoutMs =
    clampPositiveTimerTimeoutMs(
      deps.parseTimeoutMs(opts.invokeTimeout) ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
    ) ?? DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS;
  const nodeId = await deps.resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
  const invokeParams = deps.buildNodeInvokeParams({ nodeId, command, params, timeoutMs });
  const configuredGatewayTimeoutMs = parseStrictPositiveInteger(opts.timeout ?? 10_000);
  if (configuredGatewayTimeoutMs === undefined) {
    // Preserve the existing Gateway parser's actionable invalid --timeout error.
    return await deps.callGatewayCli("node.invoke", opts, invokeParams);
  }
  // Node work owns its deadline; Gateway transport needs extra time to deliver that result.
  const transportTimeoutMs = Math.max(
    clampPositiveTimerTimeoutMs(configuredGatewayTimeoutMs) ??
      DEFAULT_CANVAS_NODE_INVOKE_TIMEOUT_MS,
    addTimerTimeoutGraceMs(timeoutMs, CANVAS_NODE_INVOKE_TRANSPORT_GRACE_MS) ?? timeoutMs,
  );
  return await deps.callGatewayCli("node.invoke", opts, invokeParams, { transportTimeoutMs });
}

/** Prints the complete invocation response for machines or the existing human acknowledgement. */
function writeCanvasInvokeResult(
  deps: CanvasCliDependencies,
  opts: CanvasNodesRpcOpts,
  result: unknown,
  message: string,
): void {
  if (opts.json) {
    deps.defaultRuntime.writeJson(result);
    return;
  }
  const { ok } = deps.getNodesTheme();
  deps.defaultRuntime.log(ok(message));
}

/** Registers Canvas subcommands under the nodes CLI command group. */
export function registerNodesCanvasCommands(nodes: Command, deps: CanvasCliDependencies) {
  const canvas = nodes
    .command("canvas")
    .description("Present widget documents on a paired macOS panel");

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
            x: parseCanvasFiniteNumberOption(opts.x, "--x"),
            y: parseCanvasFiniteNumberOption(opts.y, "--y"),
            width: parseCanvasFiniteNumberOption(opts.width, "--width"),
            height: parseCanvasFiniteNumberOption(opts.height, "--height"),
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
          const result = await invokeCanvas(deps, opts, "canvas.present", params);
          writeCanvasInvokeResult(deps, opts, result, "canvas present ok");
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
          const result = await invokeCanvas(deps, opts, "canvas.hide", undefined);
          writeCanvasInvokeResult(deps, opts, result, "canvas hide ok");
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
          const result = await invokeCanvas(deps, opts, "canvas.navigate", { url });
          writeCanvasInvokeResult(deps, opts, result, "canvas navigate ok");
        });
      }),
  );
}
