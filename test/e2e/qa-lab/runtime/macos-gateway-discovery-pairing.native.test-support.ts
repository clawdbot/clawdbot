// Real Gateway process used by the disposable macOS native pairing proof.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

const [setupPath, readyPath, gatewayStateDir] = process.argv.slice(2);
if (!setupPath || !readyPath || !gatewayStateDir) {
  throw new Error("expected setup path, ready path, and Gateway state directory");
}

process.env.OPENCLAW_STATE_DIR = gatewayStateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(gatewayStateDir, "openclaw.json");
process.env.OPENCLAW_DISABLE_BONJOUR = "1";
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";
process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
process.env.OPENCLAW_SKIP_PROVIDERS = "1";
delete process.env.VITEST;

const [
  { clearConfigCache, clearRuntimeConfigSnapshot },
  { issueDevicePairSetupBootstrapToken },
  { startGatewayServer },
  { loadGatewayTlsServerRuntime },
  { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE },
] = await Promise.all([
  import("../../../../src/config/config.js"),
  import("../../../../src/infra/device-bootstrap.js"),
  import("../../../../src/gateway/server.js"),
  import("../../../../src/infra/tls/gateway.js"),
  import("../../../../src/shared/device-bootstrap-profile.js"),
]);

await fs.mkdir(gatewayStateDir, { recursive: true, mode: 0o700 });
const certPath = path.join(gatewayStateDir, "gateway-cert.pem");
const keyPath = path.join(gatewayStateDir, "gateway-key.pem");
const tls = await loadGatewayTlsServerRuntime({
  enabled: true,
  autoGenerate: true,
  certPath,
  keyPath,
});
if (!tls.enabled || !tls.fingerprintSha256) {
  throw new Error(tls.error ?? "Gateway TLS runtime did not expose a fingerprint");
}
await fs.writeFile(
  process.env.OPENCLAW_CONFIG_PATH,
  `${JSON.stringify({
    gateway: {
      auth: { mode: "token", token: "native-proof-shared-token" },
      bind: "loopback",
      controlUi: { enabled: false },
      tls: { enabled: true, autoGenerate: false, certPath, keyPath },
    },
  })}\n`,
  { encoding: "utf8", mode: 0o600 },
);
clearConfigCache();
clearRuntimeConfigSnapshot();

const issued = await issueDevicePairSetupBootstrapToken({
  profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
});
const port = await getFreePort();
const server = await startGatewayServer(port, {
  auth: { mode: "token", token: "native-proof-shared-token" },
  bind: "loopback",
  controlUiEnabled: false,
  sidecarStartup: "defer",
});

try {
  await fs.writeFile(
    setupPath,
    `${JSON.stringify({
      url: `wss://127.0.0.1:${port}`,
      tlsFingerprint: tls.fingerprintSha256,
      bootstrapToken: issued.token,
      expiresAtMs: issued.expiresAtMs,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(readyPath, "ready\n", { encoding: "utf8", mode: 0o600 });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await server.close({ reason: "macOS discovery pairing proof complete" });
}
