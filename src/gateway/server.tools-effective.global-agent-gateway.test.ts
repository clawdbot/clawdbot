/**
 * Live Gateway integration test for the tools.effective agent-ownership guard.
 *
 * Drives the real Gateway over a WebSocket RPC client against an on-disk session
 * store and config, proving a non-global session rejects a mismatched configured
 * agent before any inventory work (the security-sensitive ownership path).
 *
 * The positive global-session case is covered at the handler-integration layer
 * (`tools-effective.global-agent.integration.test.ts`); the live sessions
 * harness deliberately stubs the bundled MCP inventory runtime, so a successful
 * tools.effective inventory cannot resolve here without materializing bundled
 * plugin runtime.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { rpcReq, testState } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { openClient } = setupGatewaySessionsTestHarness();

test("tools.effective rejects a mismatched configured agent for a non-global session key", async () => {
  const reset = await configureNonGlobalMainSession();
  const { ws } = await openClient();
  try {
    const res = await rpcReq<{ agentId?: string }>(ws, "tools.effective", {
      sessionKey: "agent:main:abc",
      agentId: "work",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'agent id "work" does not match session agent "main"',
    });
  } finally {
    ws.close();
    await reset();
  }
});

/**
 * Writes a non-global config (agents main+work, default scope) plus a single
 * `agent:main:abc` session owned by `main`, and returns a cleanup callback.
 */
async function configureNonGlobalMainSession(): Promise<() => Promise<void>> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!configPath || !stateDir) {
    throw new Error("OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR are required");
  }
  const dir = path.join(stateDir, "session-stores", `tools-effective-nonglobal-${Date.now()}`);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  testState.sessionConfig = undefined;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { store: storePath },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await replaceSessionEntry(
    { storePath, sessionKey: "agent:main:abc" },
    { sessionId: "sess-main-agent", updatedAt: 1 },
  );
  return async () => {
    testState.sessionStorePath = undefined;
    await fs.writeFile(configPath, "{}\n", "utf-8");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  };
}
