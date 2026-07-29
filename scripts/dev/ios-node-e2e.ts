// Ios Node E2E script supports OpenClaw repository automation.
import { randomUUID } from "node:crypto";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/version.js";

function writeStdoutLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function usage(): string {
  return [
    "Usage: bun scripts/dev/ios-node-e2e.ts --url <wss://host[:port]> --token <gateway.auth.token> [options]",
    "Or set env: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
    "",
    "Options:",
    "  --node <id|name-substring>  Select a connected iOS node",
    "  --wait-seconds <n>          Seconds to wait for an iOS node (default: 25)",
    "  --dangerous                 Include camera/screen commands",
    "  --json                      Print JSON results",
    "  -h, --help                  Show this help",
  ].join("\n");
}

const argv = process.argv.slice(2);
const getArg = (flag: string) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const hasFlag = (flag: string) => argv.includes(flag);
const BOOLEAN_FLAGS = new Set(["--dangerous", "--help", "-h", "--json"]);
const VALUE_FLAGS = new Set(["--node", "--token", "--url", "--wait-seconds"]);

function isMissingOptionValue(value: string | undefined): boolean {
  return !value || BOOLEAN_FLAGS.has(value) || VALUE_FLAGS.has(value) || value.startsWith("--");
}

function failCli(message: string): never {
  writeStderrLine(message);
  process.exit(1);
}

function validateArgs(): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (isMissingOptionValue(value)) {
        failCli(`${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    failCli(`Unknown argument: ${arg}`);
  }
}

validateArgs();
if (hasFlag("--help") || hasFlag("-h")) {
  writeStdoutLine(usage());
  process.exit(0);
}

type NodeListPayload = {
  ts?: number;
  nodes?: Array<{
    nodeId: string;
    displayName?: string;
    platform?: string;
    connected?: boolean;
    paired?: boolean;
    commands?: string[];
    permissions?: unknown;
  }>;
};

type NodeListNode = NonNullable<NodeListPayload["nodes"]>[number];

const urlRaw = getArg("--url") ?? process.env.OPENCLAW_GATEWAY_URL;
const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const nodeHint = getArg("--node");
const dangerous = hasFlag("--dangerous") || process.env.OPENCLAW_RUN_DANGEROUS === "1";
const jsonOut = hasFlag("--json");

if (!urlRaw || !token) {
  writeStderrLine(usage());
  process.exit(1);
}

const waitSeconds = parseWaitSeconds(getArg("--wait-seconds"));
const { createGatewayWsClient, resolveGatewayUrl } = await import("./gateway-ws-client.ts");
const url = resolveGatewayUrl(urlRaw);

const isoNow = () => new Date().toISOString();
const isoMinusMs = (ms: number) => new Date(Date.now() - ms).toISOString();

type TestCase = {
  id: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  dangerous?: boolean;
};

function formatErr(err: unknown): string {
  if (!err) {
    return "error";
  }
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message || String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

function parseWaitSeconds(raw: string | undefined): number {
  const value = raw ?? "25";
  const text = value.trim();
  if (!/^[1-9]\d*$/u.test(text)) {
    writeStderrLine(`--wait-seconds must be a positive integer; got: ${value}`);
    process.exit(1);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    writeStderrLine(`--wait-seconds must be a safe positive integer; got: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function payloadShapeError(command: string, payload: unknown): string | null {
  if (payload == null) {
    return `${command} returned no payload`;
  }
  if (Array.isArray(payload)) {
    return `${command} returned an array payload`;
  }
  if (!isRecord(payload)) {
    return `${command} returned a ${typeof payload} payload`;
  }
  if (Object.keys(payload).length === 0) {
    return `${command} returned an empty object payload`;
  }
  if (command === "device.info") {
    const hasSystemName =
      typeof payload.systemName === "string" && payload.systemName.trim().length > 0;
    const hasSystemVersion =
      typeof payload.systemVersion === "string" && payload.systemVersion.trim().length > 0;
    if (!hasSystemName || !hasSystemVersion) {
      return "device.info payload missing systemName/systemVersion";
    }
  }
  return null;
}

function commandPayloadFromInvokePayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  if (typeof payload.payloadJSON === "string") {
    try {
      return JSON.parse(payload.payloadJSON);
    } catch {
      return undefined;
    }
  }
  if ("payload" in payload && ("ok" in payload || "nodeId" in payload || "command" in payload)) {
    return commandPayloadFromInvokePayload(payload.payload);
  }
  return payload;
}

function pickIosNode(list: NodeListPayload, hint?: string): NodeListNode | null {
  const nodes = (list.nodes ?? []).filter((n) => n && n.connected);
  const ios = nodes.filter((n) => (n.platform ?? "").toLowerCase().includes("ios"));
  if (ios.length === 0) {
    return null;
  }
  if (!hint) {
    return ios[0] ?? null;
  }
  const h = hint.toLowerCase();
  return (
    ios.find((n) => n.nodeId.toLowerCase() === h) ??
    ios.find((n) => (n.displayName ?? "").toLowerCase().includes(h)) ??
    ios.find((n) => n.nodeId.toLowerCase().includes(h)) ??
    ios[0] ??
    null
  );
}

async function main() {
  const { request, waitOpen, close } = createGatewayWsClient({ url: url.toString() });
  await waitOpen();

  const connectRes = await request("connect", {
    minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "cli",
      displayName: "openclaw ios node e2e",
      version: "dev",
      platform: "dev",
      mode: "cli",
      instanceId: "openclaw-dev-ios-node-e2e",
    },
    locale: "en-US",
    userAgent: "ios-node-e2e",
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
    auth: { token },
  });

  if (!connectRes.ok) {
    writeStderrLine(`connect failed: ${String(connectRes.error)}`);
    close();
    process.exit(2);
  }

  const healthRes = await request("health");
  if (!healthRes.ok) {
    writeStderrLine(`health failed: ${String(healthRes.error)}`);
    close();
    process.exit(3);
  }

  const nodesRes = await request("node.list");
  if (!nodesRes.ok) {
    writeStderrLine(`node.list failed: ${String(nodesRes.error)}`);
    close();
    process.exit(4);
  }

  const listPayload = (nodesRes.payload ?? {}) as NodeListPayload;
  let node = pickIosNode(listPayload, nodeHint);
  if (!node) {
    const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
    while (!node && Date.now() < deadline) {
      await new Promise((r) => {
        setTimeout(r, 1000);
      });
      const res = await request("node.list").catch(() => null);
      if (!res?.ok) {
        continue;
      }
      node = pickIosNode((res.payload ?? {}) as NodeListPayload, nodeHint);
    }
  }
  if (!node) {
    writeStderrLine("No connected iOS nodes found. (Is the iOS app connected to the gateway?)");
    close();
    process.exit(5);
  }

  const tests: TestCase[] = [
    { id: "device.info", command: "device.info" },
    { id: "device.status", command: "device.status" },
    {
      id: "system.notify",
      command: "system.notify",
      params: { title: "OpenClaw E2E", body: `ios-node-e2e @ ${isoNow()}`, delivery: "system" },
    },
    {
      id: "contacts.search",
      command: "contacts.search",
      params: { query: null, limit: 5 },
    },
    {
      id: "calendar.events",
      command: "calendar.events",
      params: { startISO: isoMinusMs(6 * 60 * 60 * 1000), endISO: isoNow(), limit: 10 },
    },
    {
      id: "reminders.list",
      command: "reminders.list",
      params: { status: "incomplete", limit: 10 },
    },
    {
      id: "motion.pedometer",
      command: "motion.pedometer",
      params: { startISO: isoMinusMs(60 * 60 * 1000), endISO: isoNow() },
    },
    {
      id: "photos.latest",
      command: "photos.latest",
      params: { limit: 1, maxWidth: 512, quality: 0.7 },
    },
    {
      id: "camera.snap",
      command: "camera.snap",
      params: { facing: "back", maxWidth: 768, quality: 0.7, format: "jpeg" },
      dangerous: true,
      timeoutMs: 20_000,
    },
    {
      id: "screen.record",
      command: "screen.record",
      params: { durationMs: 2_000, fps: 15, includeAudio: false },
      dangerous: true,
      timeoutMs: 30_000,
    },
  ];

  const run = tests.filter((t) => dangerous || !t.dangerous);

  const results: Array<{
    id: string;
    ok: boolean;
    error?: unknown;
    payload?: unknown;
  }> = [];

  for (const t of run) {
    const invokeRes = await request(
      "node.invoke",
      {
        nodeId: node.nodeId,
        command: t.command,
        params: t.params,
        timeoutMs: t.timeoutMs ?? 12_000,
        idempotencyKey: randomUUID(),
      },
      (t.timeoutMs ?? 12_000) + 2_000,
    ).catch((err: unknown) => {
      results.push({ id: t.id, ok: false, error: formatErr(err) });
      return null;
    });

    if (!invokeRes) {
      continue;
    }

    if (!invokeRes.ok) {
      results.push({ id: t.id, ok: false, error: invokeRes.error });
      continue;
    }

    const commandPayload = commandPayloadFromInvokePayload(invokeRes.payload);
    const payloadError = payloadShapeError(t.command, commandPayload);
    if (payloadError) {
      results.push({ id: t.id, ok: false, error: payloadError, payload: invokeRes.payload });
      continue;
    }

    results.push({ id: t.id, ok: true, payload: invokeRes.payload });
  }

  if (jsonOut) {
    writeStdoutJson({
      gateway: url.toString(),
      node: {
        nodeId: node.nodeId,
        displayName: node.displayName,
        platform: node.platform,
      },
      dangerous,
      results,
    });
  } else {
    const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
    const rows = results.map((r) => ({
      cmd: r.id,
      ok: r.ok ? "ok" : "fail",
      note: r.ok ? "" : formatErr(r.error ?? "error"),
    }));
    const width = Math.min(64, Math.max(12, ...rows.map((r) => r.cmd.length)));
    writeStdoutLine(`node: ${node.displayName ?? node.nodeId} (${node.platform ?? "unknown"})`);
    writeStdoutLine(`dangerous: ${dangerous ? "on" : "off"}`);
    writeStdoutLine();
    for (const r of rows) {
      writeStdoutLine(`${pad(r.cmd, width)}  ${pad(r.ok, 4)}  ${r.note}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  close();

  if (failed.length > 0) {
    process.exit(10);
  }
}

await main();
