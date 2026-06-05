// Node version mismatch tests protect local node identity/version checks so the
// gateway accepts matching node hosts and rejects incompatible local runtimes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewayVersion = resolveRuntimeServiceVersion(process.env);

const TEST_LOCAL_NODE_ID = "test-local-node-version-mismatch";

describe("node host version mismatch guard", () => {
  let port: number;
  let server: Awaited<ReturnType<typeof startServer>>["server"];

  beforeAll(async () => {
    // Write a node.json so the gateway's resolveLocalNodeId() finds it in the test state dir.
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (stateDir) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "node.json"),
        JSON.stringify({ version: 1, nodeId: TEST_LOCAL_NODE_ID }),
      );
    }
    const started = await startServer("secret");
    port = started.port;
    server = started.server;
  });

  afterAll(async () => {
    await server?.close();
  });

  test("local node with matching released version connects successfully", async () => {
    // Use the actual gateway version so versions match
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-match",
      clientVersion: gatewayVersion,
      instanceId: TEST_LOCAL_NODE_ID,
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
    });
    expect(client).toBeDefined();
    await client.stopAndWait({ timeoutMs: 2_000 });
  });

  test("local node with mismatched released version is rejected", async () => {
    const staleVersion = "2020.1.1";
    await expect(
      connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: "secret",
        role: "node",
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientDisplayName: "test-node-stale",
        clientVersion: staleVersion,
        instanceId: TEST_LOCAL_NODE_ID,
        mode: GATEWAY_CLIENT_MODES.NODE,
        scopes: [],
        commands: [],
        timeoutMs: 5_000,
        timeoutMessage: "expected version mismatch rejection",
      }),
    ).rejects.toThrow(/client version mismatch|version mismatch/i);
  });

  test("local node with dev/test version is allowed (not a released version)", async () => {
    // "dev" does not match YYYY.M.D, so the guard skips
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-dev",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
    });
    expect(client).toBeDefined();
    await client.stopAndWait({ timeoutMs: 2_000 });
  });

  test("local node with non-date version '1.0.0' is allowed", async () => {
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-semver",
      clientVersion: "1.0.0",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
    });
    expect(client).toBeDefined();
    await client.stopAndWait({ timeoutMs: 2_000 });
  });
});
