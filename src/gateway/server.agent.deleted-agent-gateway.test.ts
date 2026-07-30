import path from "node:path";
import { expect, test, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { agentCommand, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function configurePerAgentSessionStore(dir: string) {
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  testState.sessionStorePath = storeTemplate;
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  return storeTemplate;
}

function resetSessionStoreFixture() {
  testState.agentsConfig = undefined;
  testState.sessionStorePath = undefined;
}

test("agent RPC rejects deleted-agent session keys before dispatch", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = await configurePerAgentSessionStore(dir);
  const deletedStorePath = storeTemplate.replace("{agentId}", "deleted-agent");
  const orphanKey = "agent:deleted-agent:main";

  await writeSessionStore({
    storePath: deletedStorePath,
    agentId: "deleted-agent",
    entries: {
      [orphanKey]: sessionStoreEntry("sess-orphan"),
    },
  });

  vi.mocked(agentCommand).mockClear();
  const { ws } = await openClient();
  try {
    const blocked = await rpcReq(ws, "agent", {
      sessionKey: orphanKey,
      message: "hi",
      idempotencyKey: "proof-deleted-agent",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(agentCommand).not.toHaveBeenCalled();
  } finally {
    ws.close();
    resetSessionStoreFixture();
  }
});

test("agent RPC rejects archived session keys before dispatch", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = await configurePerAgentSessionStore(dir);
  const mainStorePath = storeTemplate.replace("{agentId}", "main");
  const archivedKey = "agent:main:subagent:archived";

  await writeSessionStore({
    storePath: mainStorePath,
    agentId: "main",
    entries: {
      [archivedKey]: sessionStoreEntry("sess-archived", { archivedAt: Date.now() }),
    },
  });

  vi.mocked(agentCommand).mockClear();
  const { ws } = await openClient();
  try {
    const blocked = await rpcReq(ws, "agent", {
      sessionKey: archivedKey,
      message: "hi",
      idempotencyKey: "proof-archived-session",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message:
        'Session "agent:main:subagent:archived" is archived. Restore it before starting new work.',
    });
    expect(agentCommand).not.toHaveBeenCalled();
  } finally {
    ws.close();
    resetSessionStoreFixture();
  }
});

test("agent RPC still dispatches for configured-agent session keys", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = await configurePerAgentSessionStore(dir);
  const mainStorePath = storeTemplate.replace("{agentId}", "main");

  await writeSessionStore({
    storePath: mainStorePath,
    agentId: "main",
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  vi.mocked(agentCommand).mockClear();
  const { ws } = await openClient();
  try {
    const accepted = await rpcReq(ws, "agent", {
      sessionKey: "main",
      message: "ping",
      idempotencyKey: "proof-main-agent",
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.payload?.status).toBe("accepted");
    expect(accepted.payload?.runId).toBe("proof-main-agent");
    await vi.waitFor(() => expect(agentCommand).toHaveBeenCalled());
  } finally {
    ws.close();
    resetSessionStoreFixture();
  }
});
