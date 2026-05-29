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

const { get: getArg } = createArgReader();
const urlRaw = getArg("--url") ?? process.env.OPENCLAW_GATEWAY_URL;
const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;

if (!urlRaw || !token) {
  writeStderrLine(
    "Usage: bun scripts/dev/gateway-smoke.ts --url <wss://host[:port]> --token <gateway.auth.token>\n" +
      "Or set env: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
  );
  process.exit(1);
}

async function main() {
  const url = resolveGatewayUrl(urlRaw);
  const { request, waitOpen, close } = createGatewayWsClient({
    url: url.toString(),
    onEvent: (evt) => {
      // Ignore noisy connect handshakes.
      if (evt.event === "connect.challenge") {
        return;
      }
    },
  });

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
    auth: { token },
  });

  if (!connectRes.ok) {
    writeStderrLine(`connect failed: ${String(connectRes.error)}`);
    process.exit(2);
  }

  const healthRes = await request("health");
  if (!healthRes.ok) {
    writeStderrLine(`health failed: ${String(healthRes.error)}`);
    process.exit(3);
  }

  const historyRes = await request("chat.history", { sessionKey: "main" }, 15000);
  if (!historyRes.ok) {
    writeStderrLine(`chat.history failed: ${String(historyRes.error)}`);
    process.exit(4);
  }

  writeStdoutLine("ok: connected + health + chat.history");
  close();
}

await main();
