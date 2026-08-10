import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { rpcReq, testState } from "./test-helpers.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore, openClient } = setupGatewaySessionsTestHarness();

test("real Gateway resolves the parent agent before sandbox cwd preflight", async () => {
  const { dir } = await createSelectedGlobalSessionStore();
  const mainWorkspace = path.join(dir, "main-workspace");
  const workWorkspace = path.join(dir, "work-workspace");
  const workCwd = path.join(workWorkspace, "packages", "app");
  await fs.mkdir(mainWorkspace, { recursive: true });
  await fs.mkdir(workCwd, { recursive: true });
  testState.agentsConfig = {
    list: [
      { id: "main", default: true, workspace: mainWorkspace, sandbox: { mode: "all" } },
      { id: "work", workspace: workWorkspace, sandbox: { mode: "all" } },
    ],
  };
  const { ws } = await openClient({
    browserOrigin: "http://127.0.0.1",
    client: {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "dev",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  });
  try {
    const parent = await rpcReq<{ key?: string }>(ws, "sessions.create", { agentId: "work" });
    expect(parent.ok, JSON.stringify(parent.error)).toBe(true);
    const parentSessionKey = parent.payload?.key;
    expect(parentSessionKey).toMatch(/^agent:work:dashboard:/u);

    const child = await rpcReq<{
      key?: string;
      entry?: { spawnedCwd?: string };
    }>(ws, "sessions.create", { parentSessionKey, cwd: workCwd });

    expect(child.ok, JSON.stringify(child.error)).toBe(true);
    expect(child.payload?.key).toMatch(/^agent:work:dashboard:/u);
    expect(child.payload?.entry?.spawnedCwd).toBe(workCwd);
  } finally {
    ws.close();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    testState.agentsConfig = undefined;
    testState.sessionConfig = undefined;
    testState.sessionStorePath = undefined;
  }
});
