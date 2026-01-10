import fs from "node:fs/promises";
import type { Command } from "commander";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-provider.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
} from "./nodes-camera.js";
import {
  canvasSnapshotTempPath,
  parseCanvasSnapshotPayload,
} from "./nodes-canvas.js";
import { parseEnvPairs, parseTimeoutMs } from "./nodes-run.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "./nodes-screen.js";
import { parseDurationMs } from "./parse-duration.js";
import { withProgress } from "./progress.js";

type NodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  command?: string;
  params?: string;
  invokeTimeout?: string;
  idempotencyKey?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  js?: string;
  jsonl?: string;
  text?: string;
  cwd?: string;
  env?: string[];
  commandTimeout?: string;
  needsScreenRecording?: boolean;
  title?: string;
  body?: string;
  sound?: string;
  priority?: string;
  delivery?: string;
  name?: string;
  facing?: string;
  format?: string;
  maxWidth?: string;
  quality?: string;
  delayMs?: string;
  deviceId?: string;
  maxAge?: string;
  accuracy?: string;
  locationTimeout?: string;
  duration?: string;
  screen?: string;
  fps?: string;
  audio?: boolean;
};

type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
};

type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts: number;
};

type PairedNode = {
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  permissions?: Record<string, boolean>;
  createdAtMs?: number;
  approvedAtMs?: number;
};

type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};

const A2UI_ACTION_KEYS = [
  "beginRendering",
  "surfaceUpdate",
  "dataModelUpdate",
  "deleteSurface",
  "createSurface",
] as const;

type A2UIVersion = "v0.8" | "v0.9";

const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option(
      "--timeout <ms>",
      "Timeout in ms",
      String(defaults?.timeoutMs ?? 10_000),
    )
    .option("--json", "Output JSON", false);

const callGatewayCli = async (
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
) =>
  withProgress(
    {
      label: `Nodes ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

function formatAge(msAgo: number) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function parsePairingList(value: unknown): PairingList {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const pending = Array.isArray(obj.pending)
    ? (obj.pending as PendingRequest[])
    : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

function parseNodeList(value: unknown): NodeListNode[] {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}

function formatPermissions(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, value]) => [String(key).trim(), value === true] as const)
    .filter(([key]) => key.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  const parts = entries.map(
    ([key, granted]) => `${key}=${granted ? "yes" : "no"}`,
  );
  return `[${parts.join(", ")}]`;
}

function unauthorizedHintForMessage(message: string): string | null {
  const haystack = message.toLowerCase();
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

function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

async function resolveNodeId(opts: NodesRpcOpts, query: string) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("node required");

  let nodes: NodeListNode[] = [];
  try {
    const res = (await callGatewayCli("node.list", opts, {})) as unknown;
    nodes = parseNodeList(res);
  } catch {
    const res = (await callGatewayCli("node.pair.list", opts, {})) as unknown;
    const { paired } = parsePairingList(res);
    nodes = paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      version: n.version,
      remoteIp: n.remoteIp,
    }));
  }

  const qNorm = normalizeNodeKey(q);
  const matches = nodes.filter((n) => {
    if (n.nodeId === q) return true;
    if (typeof n.remoteIp === "string" && n.remoteIp === q) return true;
    const name = typeof n.displayName === "string" ? n.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) return true;
    if (q.length >= 6 && n.nodeId.startsWith(q)) return true;
    return false;
  });

  if (matches.length === 1) return matches[0].nodeId;
  if (matches.length === 0) {
    const known = nodes
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .filter(Boolean)
      .join(", ");
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }
  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .join(", ")})`,
  );
}

function buildA2UITextJsonl(text: string) {
  const surfaceId = "main";
  const rootId = "root";
  const textId = "text";
  const payloads = [
    {
      surfaceUpdate: {
        surfaceId,
        components: [
          {
            id: rootId,
            component: { Column: { children: { explicitList: [textId] } } },
          },
          {
            id: textId,
            component: {
              Text: { text: { literalString: text }, usageHint: "body" },
            },
          },
        ],
      },
    },
    { beginRendering: { surfaceId, root: rootId } },
  ];
  return payloads.map((payload) => JSON.stringify(payload)).join("\n");
}

function validateA2UIJsonl(jsonl: string) {
  const lines = jsonl.split(/\r?\n/);
  const errors: string[] = [];
  let sawV08 = false;
  let sawV09 = false;
  let messageCount = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    messageCount += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed) as unknown;
    } catch (err) {
      errors.push(`line ${idx + 1}: ${String(err)}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      errors.push(`line ${idx + 1}: expected JSON object`);
      return;
    }
    const record = obj as Record<string, unknown>;
    const actionKeys = A2UI_ACTION_KEYS.filter((key) => key in record);
    if (actionKeys.length !== 1) {
      errors.push(
        `line ${idx + 1}: expected exactly one action key (${A2UI_ACTION_KEYS.join(
          ", ",
        )})`,
      );
      return;
    }
    if (actionKeys[0] === "createSurface") {
      sawV09 = true;
    } else {
      sawV08 = true;
    }
  });

  if (messageCount === 0) {
    errors.push("no JSONL messages found");
  }
  if (sawV08 && sawV09) {
    errors.push("mixed A2UI v0.8 and v0.9 messages in one file");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid A2UI JSONL:\n- ${errors.join("\n- ")}`);
  }

  const version: A2UIVersion = sawV09 ? "v0.9" : "v0.8";
  return { version, messageCount };
}

export function registerNodesCli(program: Command) {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned node pairing")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/nodes",
          "docs.clawd.bot/nodes",
        )}\n`,
    );

  nodesCallOpts(
    nodes
      .command("status")
      .description("List known nodes with connection status and capabilities")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.list",
            opts,
            {},
          )) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const nodes = parseNodeList(result);
          const pairedCount = nodes.filter((n) => Boolean(n.paired)).length;
          const connectedCount = nodes.filter((n) =>
            Boolean(n.connected),
          ).length;
          defaultRuntime.log(
            `Known: ${nodes.length} · Paired: ${pairedCount} · Connected: ${connectedCount}`,
          );
          for (const n of nodes) {
            const name = n.displayName || n.nodeId;
            const ip = n.remoteIp ? ` · ${n.remoteIp}` : "";
            const device = n.deviceFamily ? ` · device: ${n.deviceFamily}` : "";
            const hw = n.modelIdentifier ? ` · hw: ${n.modelIdentifier}` : "";
            const perms = formatPermissions(n.permissions);
            const permsText = perms ? ` · perms: ${perms}` : "";
            const caps =
              Array.isArray(n.caps) && n.caps.length > 0
                ? `[${n.caps.map(String).filter(Boolean).sort().join(",")}]`
                : Array.isArray(n.caps)
                  ? "[]"
                  : "?";
            const pairing = n.paired ? "paired" : "unpaired";
            defaultRuntime.log(
              `- ${name} · ${n.nodeId}${ip}${device}${hw}${permsText} · ${pairing} · ${n.connected ? "connected" : "disconnected"} · caps: ${caps}`,
            );
          }
        } catch (err) {
          defaultRuntime.error(`nodes status failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("describe")
      .description("Describe a node (capabilities + supported invoke commands)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const result = (await callGatewayCli("node.describe", opts, {
            nodeId,
          })) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const obj =
            typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : {};
          const displayName =
            typeof obj.displayName === "string" ? obj.displayName : nodeId;
          const connected = Boolean(obj.connected);
          const caps = Array.isArray(obj.caps)
            ? obj.caps.map(String).filter(Boolean).sort()
            : null;
          const commands = Array.isArray(obj.commands)
            ? obj.commands.map(String).filter(Boolean).sort()
            : [];
          const perms = formatPermissions(obj.permissions);
          const family =
            typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
          const model =
            typeof obj.modelIdentifier === "string"
              ? obj.modelIdentifier
              : null;
          const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;

          const parts: string[] = ["Node:", displayName, nodeId];
          if (ip) parts.push(ip);
          if (family) parts.push(`device: ${family}`);
          if (model) parts.push(`hw: ${model}`);
          if (perms) parts.push(`perms: ${perms}`);
          parts.push(connected ? "connected" : "disconnected");
          parts.push(`caps: ${caps ? `[${caps.join(",")}]` : "?"}`);
          defaultRuntime.log(parts.join(" · "));
          defaultRuntime.log("Commands:");
          if (commands.length === 0) {
            defaultRuntime.log("- (none reported)");
            return;
          }
          for (const c of commands) defaultRuntime.log(`- ${c}`);
        } catch (err) {
          defaultRuntime.error(`nodes describe failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.pair.list",
            opts,
            {},
          )) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const { pending, paired } = parsePairingList(result);
          defaultRuntime.log(
            `Pending: ${pending.length} · Paired: ${paired.length}`,
          );
          if (pending.length > 0) {
            defaultRuntime.log("\nPending:");
            for (const r of pending) {
              const name = r.displayName || r.nodeId;
              const repair = r.isRepair ? " (repair)" : "";
              const ip = r.remoteIp ? ` · ${r.remoteIp}` : "";
              const age =
                typeof r.ts === "number"
                  ? ` · ${formatAge(Date.now() - r.ts)} ago`
                  : "";
              defaultRuntime.log(
                `- ${r.requestId}: ${name}${repair}${ip}${age}`,
              );
            }
          }
          if (paired.length > 0) {
            defaultRuntime.log("\nPaired:");
            for (const n of paired) {
              const name = n.displayName || n.nodeId;
              const ip = n.remoteIp ? ` · ${n.remoteIp}` : "";
              defaultRuntime.log(`- ${n.nodeId}: ${name}${ip}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(`nodes list failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("pending")
      .description("List pending pairing requests")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.pair.list",
            opts,
            {},
          )) as unknown;
          const { pending } = parsePairingList(result);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(pending, null, 2));
            return;
          }
          if (pending.length === 0) {
            defaultRuntime.log("No pending pairing requests.");
            return;
          }
          for (const r of pending) {
            const name = r.displayName || r.nodeId;
            const repair = r.isRepair ? " (repair)" : "";
            const ip = r.remoteIp ? ` · ${r.remoteIp}` : "";
            const age =
              typeof r.ts === "number"
                ? ` · ${formatAge(Date.now() - r.ts)} ago`
                : "";
            defaultRuntime.log(`- ${r.requestId}: ${name}${repair}${ip}${age}`);
          }
        } catch (err) {
          defaultRuntime.error(`nodes pending failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("approve")
      .description("Approve a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        try {
          const result = await callGatewayCli("node.pair.approve", opts, {
            requestId,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes approve failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("reject")
      .description("Reject a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        try {
          const result = await callGatewayCli("node.pair.reject", opts, {
            requestId,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes reject failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("rename")
      .description("Rename a paired node (display name override)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--name <displayName>", "New display name")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const name = String(opts.name ?? "").trim();
          if (!nodeId || !name) {
            defaultRuntime.error("--node and --name required");
            defaultRuntime.exit(1);
            return;
          }
          const result = await callGatewayCli("node.rename", opts, {
            nodeId,
            displayName: name,
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log(`node rename ok: ${nodeId} -> ${name}`);
        } catch (err) {
          defaultRuntime.error(`nodes rename failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. canvas.eval)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 15000)",
        "15000",
      )
      .option("--idempotency-key <key>", "Idempotency key (optional)")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const command = String(opts.command ?? "").trim();
          if (!nodeId || !command) {
            defaultRuntime.error("--node and --command required");
            defaultRuntime.exit(1);
            return;
          }
          const params = JSON.parse(String(opts.params ?? "{}")) as unknown;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command,
            params,
            idempotencyKey: String(
              opts.idempotencyKey ?? randomIdempotencyKey(),
            ),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const result = await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          );

          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes invoke failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 30_000 },
  );

  nodesCallOpts(
    nodes
      .command("run")
      .description("Run a shell command on a node (mac only)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--cwd <path>", "Working directory")
      .option(
        "--env <key=val>",
        "Environment override (repeatable)",
        (value: string, prev: string[] = []) => [...prev, value],
      )
      .option("--command-timeout <ms>", "Command timeout (ms)")
      .option("--needs-screen-recording", "Require screen recording permission")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 30000)",
        "30000",
      )
      .argument("<command...>", "Command and args")
      .action(async (command: string[], opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          if (!Array.isArray(command) || command.length === 0) {
            throw new Error("command required");
          }
          const env = parseEnvPairs(opts.env);
          const timeoutMs = parseTimeoutMs(opts.commandTimeout);
          const invokeTimeout = parseTimeoutMs(opts.invokeTimeout);

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "system.run",
            params: {
              command,
              cwd: opts.cwd,
              env,
              timeoutMs,
              needsScreenRecording: opts.needsScreenRecording === true,
            },
            idempotencyKey: String(
              opts.idempotencyKey ?? randomIdempotencyKey(),
            ),
          };
          if (invokeTimeout !== undefined) {
            invokeParams.timeoutMs = invokeTimeout;
          }

          const result = (await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          )) as unknown;

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const payload =
            typeof result === "object" && result !== null
              ? (result as { payload?: Record<string, unknown> }).payload
              : undefined;

          const stdout =
            typeof payload?.stdout === "string" ? payload.stdout : "";
          const stderr =
            typeof payload?.stderr === "string" ? payload.stderr : "";
          const exitCode =
            typeof payload?.exitCode === "number" ? payload.exitCode : null;
          const timedOut = payload?.timedOut === true;
          const success = payload?.success === true;

          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (timedOut) {
            defaultRuntime.error("run timed out");
            defaultRuntime.exit(1);
            return;
          }
          if (exitCode !== null && exitCode !== 0) {
            const hint = unauthorizedHintForMessage(`${stderr}\n${stdout}`);
            if (hint) defaultRuntime.error(hint);
          }
          if (exitCode !== null && exitCode !== 0 && !success) {
            defaultRuntime.error(`run exit ${exitCode}`);
            defaultRuntime.exit(1);
            return;
          }
        } catch (err) {
          defaultRuntime.error(`nodes run failed: ${String(err)}`);
          const hint = unauthorizedHintForMessage(String(err));
          if (hint) defaultRuntime.error(hint);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 35_000 },
  );

  nodesCallOpts(
    nodes
      .command("notify")
      .description("Send a local notification on a node (mac only)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Notification title")
      .option("--body <text>", "Notification body")
      .option("--sound <name>", "Notification sound")
      .option(
        "--priority <passive|active|timeSensitive>",
        "Notification priority",
      )
      .option("--delivery <system|overlay|auto>", "Delivery mode", "system")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 15000)",
        "15000",
      )
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const title = String(opts.title ?? "").trim();
          const body = String(opts.body ?? "").trim();
          if (!title && !body) {
            throw new Error("missing --title or --body");
          }
          const invokeTimeout = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;
          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "system.notify",
            params: {
              title,
              body,
              sound: opts.sound,
              priority: opts.priority,
              delivery: opts.delivery,
            },
            idempotencyKey: String(
              opts.idempotencyKey ?? randomIdempotencyKey(),
            ),
          };
          if (
            typeof invokeTimeout === "number" &&
            Number.isFinite(invokeTimeout)
          ) {
            invokeParams.timeoutMs = invokeTimeout;
          }

          const result = await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          );

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log("notify ok");
        } catch (err) {
          defaultRuntime.error(`nodes notify failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  const parseFacing = (value: string): CameraFacing => {
    const v = String(value ?? "")
      .trim()
      .toLowerCase();
    if (v === "front" || v === "back") return v;
    throw new Error(`invalid facing: ${value} (expected front|back)`);
  };

  const camera = nodes
    .command("camera")
    .description("Capture camera media from a paired node");

  const canvas = nodes
    .command("canvas")
    .description("Capture or render canvas content from a paired node");

  const invokeCanvas = async (
    opts: NodesRpcOpts,
    command: string,
    params?: Record<string, unknown>,
  ) => {
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
  };

  nodesCallOpts(
    canvas
      .command("snapshot")
      .description("Capture a canvas snapshot (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--format <png|jpg|jpeg>", "Image format", "jpg")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (optional)")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 20000)",
        "20000",
      )
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const formatOpt = String(opts.format ?? "jpg")
            .trim()
            .toLowerCase();
          const formatForParams =
            formatOpt === "jpg"
              ? "jpeg"
              : formatOpt === "jpeg"
                ? "jpeg"
                : "png";
          if (formatForParams !== "png" && formatForParams !== "jpeg") {
            throw new Error(
              `invalid format: ${String(opts.format)} (expected png|jpg|jpeg)`,
            );
          }

          const maxWidth = opts.maxWidth
            ? Number.parseInt(String(opts.maxWidth), 10)
            : undefined;
          const quality = opts.quality
            ? Number.parseFloat(String(opts.quality))
            : undefined;
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

          const raw = (await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          )) as unknown;

          const res =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: unknown })
              : {};
          const payload = parseCanvasSnapshotPayload(res.payload);
          const filePath = canvasSnapshotTempPath({
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                { file: { path: filePath, format: payload.format } },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${filePath}`);
        } catch (err) {
          defaultRuntime.error(`nodes canvas snapshot failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
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
        try {
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
            defaultRuntime.log("canvas present ok");
          }
        } catch (err) {
          defaultRuntime.error(`nodes canvas present failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    canvas
      .command("hide")
      .description("Hide the canvas")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        try {
          await invokeCanvas(opts, "canvas.hide", undefined);
          if (!opts.json) {
            defaultRuntime.log("canvas hide ok");
          }
        } catch (err) {
          defaultRuntime.error(`nodes canvas hide failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
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
        try {
          await invokeCanvas(opts, "canvas.navigate", { url });
          if (!opts.json) {
            defaultRuntime.log("canvas navigate ok");
          }
        } catch (err) {
          defaultRuntime.error(`nodes canvas navigate failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
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
        try {
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
          if (payload?.result) {
            defaultRuntime.log(payload.result);
          } else {
            defaultRuntime.log("canvas eval ok");
          }
        } catch (err) {
          defaultRuntime.error(`nodes canvas eval failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  const a2ui = canvas
    .command("a2ui")
    .description("Render A2UI content on the canvas");

  nodesCallOpts(
    a2ui
      .command("push")
      .description("Push A2UI JSONL to the canvas")
      .option("--jsonl <path>", "Path to JSONL payload")
      .option("--text <text>", "Render a quick A2UI text payload")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        try {
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
              "Detected A2UI v0.9 JSONL (createSurface). Clawdbot currently supports v0.8 only.",
            );
          }
          await invokeCanvas(opts, "canvas.a2ui.pushJSONL", { jsonl });
          if (!opts.json) {
            defaultRuntime.log(
              `canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`,
            );
          }
        } catch (err) {
          defaultRuntime.error(`nodes canvas a2ui push failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    a2ui
      .command("reset")
      .description("Reset A2UI renderer state")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms")
      .action(async (opts: NodesRpcOpts) => {
        try {
          await invokeCanvas(opts, "canvas.a2ui.reset", undefined);
          if (!opts.json) {
            defaultRuntime.log("canvas a2ui reset ok");
          }
        } catch (err) {
          defaultRuntime.error(
            `nodes canvas a2ui reset failed: ${String(err)}`,
          );
          defaultRuntime.exit(1);
        }
      }),
  );

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
          const devices = Array.isArray(payload.devices)
            ? (payload.devices as Array<Record<string, unknown>>)
            : [];

          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ devices }, null, 2));
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
            opts.out ??
            screenRecordTempPath({
              ext: parsed.format || "mp4",
            });
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

  const location = nodes
    .command("location")
    .description("Fetch location from a paired node");

  nodesCallOpts(
    location
      .command("get")
      .description("Fetch the current location from a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--max-age <ms>", "Use cached location newer than this (ms)")
      .option(
        "--accuracy <coarse|balanced|precise>",
        "Desired accuracy (default: balanced/precise depending on node setting)",
      )
      .option("--location-timeout <ms>", "Location fix timeout (ms)", "10000")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 20000)",
        "20000",
      )
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const maxAgeMs = opts.maxAge
            ? Number.parseInt(String(opts.maxAge), 10)
            : undefined;
          const desiredAccuracyRaw =
            typeof opts.accuracy === "string"
              ? opts.accuracy.trim().toLowerCase()
              : undefined;
          const desiredAccuracy =
            desiredAccuracyRaw === "coarse" ||
            desiredAccuracyRaw === "balanced" ||
            desiredAccuracyRaw === "precise"
              ? desiredAccuracyRaw
              : undefined;
          const timeoutMs = opts.locationTimeout
            ? Number.parseInt(String(opts.locationTimeout), 10)
            : undefined;
          const invokeTimeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "location.get",
            params: {
              maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : undefined,
              desiredAccuracy,
              timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
            },
            idempotencyKey: randomIdempotencyKey(),
          };
          if (
            typeof invokeTimeoutMs === "number" &&
            Number.isFinite(invokeTimeoutMs)
          ) {
            invokeParams.timeoutMs = invokeTimeoutMs;
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
          const payload =
            res.payload && typeof res.payload === "object"
              ? (res.payload as Record<string, unknown>)
              : {};

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(payload, null, 2));
            return;
          }

          const lat = payload.lat;
          const lon = payload.lon;
          const acc = payload.accuracyMeters;
          if (typeof lat === "number" && typeof lon === "number") {
            const accText =
              typeof acc === "number" ? ` ±${acc.toFixed(1)}m` : "";
            defaultRuntime.log(`${lat},${lon}${accText}`);
            return;
          }
          defaultRuntime.log(JSON.stringify(payload));
        } catch (err) {
          defaultRuntime.error(`nodes location get failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 30_000 },
  );
}
