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
  writeStderrLine(
    "Usage: bun scripts/dev/gateway-smoke.ts --url <wss://host[:port]> --token <gateway.auth.token>\n" +
      "Or set env: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
  );
}

type GatewaySmokeClient = ReturnType<typeof createGatewayWsClient>;

type GatewaySmokeDeps = {
  createClient?: typeof createGatewayWsClient;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
};

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
  const { get: getArg } = createArgReader();
  const urlRaw = getArg("--url") ?? process.env.OPENCLAW_GATEWAY_URL;
  const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!urlRaw || !token) {
    writeUsage();
    process.exitCode = 1;
  } else {
    process.exitCode = await runGatewaySmoke({ token, urlRaw });
  }
}
