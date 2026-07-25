// Gateway Smoke script supports OpenClaw repository automation.
import { fileURLToPath } from "node:url";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/version.js";
import { createArgReader, createGatewayWsClient, resolveGatewayUrl } from "./gateway-ws-client.ts";

function writeStdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function writeUsage(): void {
  writeStderrLine(usage());
}

type GatewaySmokeClient = ReturnType<typeof createGatewayWsClient>;
type GatewaySmokeCliOptions = {
  help: boolean;
  token?: string;
  urlRaw?: string;
};

type GatewaySmokeDeps = {
  createClient?: typeof createGatewayWsClient;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
};

class GatewaySmokeArgError extends Error {}

const BOOLEAN_FLAGS = new Set(["--help", "-h"]);
const VALUE_FLAGS = new Set(["--url", "--token"]);

function usage(): string {
  return [
    "Usage: bun scripts/dev/gateway-smoke.ts --url <wss://host[:port]> --token <gateway.auth.token>",
    "Or set env: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
    "",
    "Options:",
    "  --url <url>       Gateway websocket URL",
    "  --token <token>   Gateway auth token",
    "  -h, --help        Show this help",
  ].join("\n");
}

function validateArgs(argv: readonly string[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      if (seen.has(arg)) {
        throw new GatewaySmokeArgError(`${arg} was provided more than once`);
      }
      seen.add(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new GatewaySmokeArgError(`${arg} requires a value`);
      }
      if (seen.has(arg)) {
        throw new GatewaySmokeArgError(`${arg} was provided more than once`);
      }
      seen.add(arg);
      index += 1;
      continue;
    }
    throw new GatewaySmokeArgError(`Unknown argument: ${arg}`);
  }
}

function parseGatewaySmokeCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GatewaySmokeCliOptions {
  validateArgs(argv);
  const { get: getArg, has } = createArgReader([...argv]);
  return {
    help: has("--help") || has("-h"),
    token: getArg("--token") ?? env.OPENCLAW_GATEWAY_TOKEN,
    urlRaw: getArg("--url") ?? env.OPENCLAW_GATEWAY_URL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasHealthSummaryPayload(response: unknown): boolean {
  if (!isRecord(response) || !isRecord(response.payload)) {
    return false;
  }
  const { payload } = response;
  return (
    payload.ok === true &&
    typeof payload.ts === "number" &&
    typeof payload.durationMs === "number" &&
    typeof payload.defaultAgentId === "string" &&
    payload.defaultAgentId.trim() !== "" &&
    Array.isArray(payload.agents) &&
    isRecord(payload.channels) &&
    Array.isArray(payload.channelOrder) &&
    isRecord(payload.sessions)
  );
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function connectHelloScopes(response: unknown): string[] | null {
  if (!isRecord(response) || !isRecord(response.payload)) {
    return null;
  }
  const { payload } = response;
  if (
    payload.type !== "hello-ok" ||
    typeof payload.protocol !== "number" ||
    !isRecord(payload.features) ||
    !hasStringArray(payload.features.methods) ||
    !payload.features.methods.includes("health") ||
    !isRecord(payload.auth) ||
    payload.auth.role !== "operator" ||
    !hasStringArray(payload.auth.scopes)
  ) {
    return null;
  }
  return payload.auth.scopes;
}

function hasConnectHelloPayload(response: unknown): boolean {
  return connectHelloScopes(response) !== null;
}

function hasUnpairedOperatorScopes(response: unknown): boolean {
  const scopes = connectHelloScopes(response);
  if (!scopes) {
    return false;
  }
  return scopes.length > 0;
}

export async function runGatewaySmoke(
  input: { token: string; urlRaw: string },
  deps: GatewaySmokeDeps = {},
): Promise<number> {
  const url = resolveGatewayUrl(input.urlRaw);
  const createClient = deps.createClient ?? createGatewayWsClient;
  const stderr = deps.stderr ?? writeStderrLine;
  const stdout = deps.stdout ?? writeStdoutLine;
  const client: GatewaySmokeClient = createClient({
    url: url.toString(),
    onEvent: (evt) => {
      // Ignore noisy connect handshakes.
      void evt;
    },
  });
  const { request, waitOpen, close } = client;

  try {
    await waitOpen();

    // Match iOS "operator" session defaults: token auth, no device identity.
    const connectRes = await request("connect", {
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-ios",
        displayName: "openclaw gateway smoke test",
        version: "dev",
        platform: "dev",
        mode: "ui",
        instanceId: "openclaw-dev-smoke",
      },
      locale: "en-US",
      userAgent: "gateway-smoke",
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
      auth: { token: input.token },
    });

    if (!connectRes.ok) {
      stderr(`connect failed: ${String(connectRes.error)}`);
      return 2;
    }
    if (!hasConnectHelloPayload(connectRes)) {
      stderr("connect failed: missing hello-ok payload");
      return 2;
    }
    if (hasUnpairedOperatorScopes(connectRes)) {
      stderr("connect failed: unpaired iOS smoke unexpectedly received operator scopes");
      return 2;
    }

    const healthRes = await request("health");
    if (!healthRes.ok) {
      stderr(`health failed: ${String(healthRes.error)}`);
      return 3;
    }
    if (!hasHealthSummaryPayload(healthRes)) {
      stderr("health failed: missing health summary payload");
      return 3;
    }

    stdout("ok: connected + health");
    return 0;
  } finally {
    close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let cli: GatewaySmokeCliOptions;
  try {
    cli = parseGatewaySmokeCli();
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (cli.help) {
    writeStdoutLine(usage());
  } else if (!cli.urlRaw || !cli.token) {
    writeUsage();
    process.exitCode = 1;
  } else {
    process.exitCode = await runGatewaySmoke({ token: cli.token, urlRaw: cli.urlRaw });
  }
}
