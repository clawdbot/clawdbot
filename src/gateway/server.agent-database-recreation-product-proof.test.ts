import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "./test-helpers.js";

const AGENT_ID = "recreated-agent";
const SESSION_KEY = `agent:${AGENT_ID}:product-proof`;

installGatewayTestHooks();

describe("agent database recreation product proof", () => {
  it(
    "recreates and registers a deleted agent database through one real Gateway process",
    { timeout: 180_000 },
    async () => {
      const port = await getGatewayTestPort();
      const token = "agent-database-recreation-product-proof-token";
      const url = `ws://127.0.0.1:${port}`;
      const server = await startTestGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let client: GatewayClient | undefined;
      try {
        client = await connectGatewayClient({
          url,
          token,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });

        const workspace = path.join(
          process.env.OPENCLAW_STATE_DIR ?? process.cwd(),
          "workspace-recreated-agent",
        );
        const created = await client.request<{ agentId: string; ok: true }>("agents.create", {
          name: "Recreated Agent",
          workspace,
        });
        expect(created).toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(
          client.request("sessions.create", { agentId: AGENT_ID, key: SESSION_KEY }),
        ).resolves.toMatchObject({ key: SESSION_KEY });
        await expect(client.request("sessions.list", { agentId: AGENT_ID })).resolves.toMatchObject(
          { sessions: [expect.objectContaining({ key: SESSION_KEY })] },
        );

        const databasePath = resolveOpenClawAgentSqlitePath({
          agentId: AGENT_ID,
          env: process.env,
        });
        const originalIdentity = await fs.stat(databasePath, { bigint: true });

        await expect(
          client.request("agents.delete", { agentId: AGENT_ID, deleteFiles: true }),
        ).resolves.toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

        const recreated = await client.request<{ agentId: string; ok: true }>("agents.create", {
          name: "Recreated Agent",
          workspace,
        });
        expect(recreated).toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(
          client.request("sessions.create", { agentId: AGENT_ID, key: SESSION_KEY }),
        ).resolves.toMatchObject({ key: SESSION_KEY });
        await expect(client.request("sessions.list", { agentId: AGENT_ID })).resolves.toMatchObject(
          { sessions: [expect.objectContaining({ key: SESSION_KEY })] },
        );
        await expect(client.request("health", { probe: true })).resolves.toBeDefined();

        const recreatedIdentity = await fs.stat(databasePath, { bigint: true });
        expect({
          birthtimeNs: recreatedIdentity.birthtimeNs,
          dev: recreatedIdentity.dev,
          ino: recreatedIdentity.ino,
        }).not.toEqual({
          birthtimeNs: originalIdentity.birthtimeNs,
          dev: originalIdentity.dev,
          ino: originalIdentity.ino,
        });
        expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
          agentId: AGENT_ID,
          status: "owned",
        });
        expect(listOpenClawRegisteredAgentDatabases({ env: process.env })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ agentId: AGENT_ID, path: databasePath }),
          ]),
        );
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server.close({ reason: "agent database recreation product proof complete" });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});
