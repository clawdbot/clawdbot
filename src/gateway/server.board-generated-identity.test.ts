import { expect, it } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { READ_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { getFreePort, installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const SESSION_KEY = "agent:main:generated-identity-restart";

function putGeneratedWidget(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  params: { title: string; key: string; fallbackName: string; html: string },
) {
  return client.request<BoardWidgetPutResult>("board.widget.put", {
    sessionKey: SESSION_KEY,
    name: "2024",
    title: params.title,
    content: { kind: "html", html: params.html },
    generatedIdentity: {
      source: "show_widget",
      key: params.key.repeat(64),
      fallbackName: params.fallbackName,
    },
  });
}

it(
  "preserves generated identities across two connections and a real gateway restart",
  { timeout: 120_000 },
  async () => {
    const env = { ...process.env };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: SESSION_KEY, storePath: database.path },
      { sessionId: "generated-identity-restart", updatedAt: Date.now() },
    );

    const events: string[] = [];
    const start = async () => {
      const port = await getFreePort();
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      return { port, server };
    };
    const connect = (port: number, deviceFamily: string) =>
      connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        deviceFamily,
        scopes: [READ_SCOPE, WRITE_SCOPE],
        onEvent: (event) => {
          if (
            event.event === "board.changed" &&
            event.payload &&
            typeof event.payload === "object" &&
            typeof (event.payload as { widget?: unknown }).widget === "string"
          ) {
            events.push((event.payload as { widget: string }).widget);
          }
        },
        timeoutMs: 30_000,
      });

    let firstServer: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let firstClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let secondClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let restartedServer: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let restartedClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      const first = await start();
      firstServer = first.server;
      [firstClient, secondClient] = await Promise.all([
        connect(first.port, "generated-a"),
        connect(first.port, "generated-b"),
      ]);
      const initial = await Promise.all([
        putGeneratedWidget(firstClient, {
          title: "売上レポート 2024",
          key: "a",
          fallbackName: "2024-aaaaaaaa",
          html: "<p>sales</p>",
        }),
        putGeneratedWidget(secondClient, {
          title: "在庫レポート 2024",
          key: "b",
          fallbackName: "2024-bbbbbbbb",
          html: "<p>inventory</p>",
        }),
      ]);
      const initialNames = initial.map((result) => result.resolvedWidgetName);
      expect(new Set(initialNames).size).toBe(2);
      expect(initialNames).toContain("2024");

      await Promise.all([
        disconnectGatewayClient(firstClient),
        disconnectGatewayClient(secondClient),
      ]);
      firstClient = undefined;
      secondClient = undefined;
      await firstServer.close();
      firstServer = undefined;
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();

      const restarted = await start();
      restartedServer = restarted.server;
      restartedClient = await connect(restarted.port, "generated-restart");
      const snapshot = await restartedClient.request<BoardSnapshot>("board.get", {
        sessionKey: SESSION_KEY,
      });
      expect(new Set(snapshot.widgets.map((widget) => widget.name))).toEqual(new Set(initialNames));

      const reloaded = await Promise.all([
        putGeneratedWidget(restartedClient, {
          title: "売上レポート 2024",
          key: "a",
          fallbackName: "2024-aaaaaaaa",
          html: "<p>sales revised</p>",
        }),
        putGeneratedWidget(restartedClient, {
          title: "在庫レポート 2024",
          key: "b",
          fallbackName: "2024-bbbbbbbb",
          html: "<p>inventory revised</p>",
        }),
      ]);
      expect(new Set(reloaded.map((result) => result.resolvedWidgetName))).toEqual(
        new Set(initialNames),
      );
      expect(events).toEqual(expect.arrayContaining(initialNames));
    } finally {
      if (firstClient) {
        await disconnectGatewayClient(firstClient).catch(() => undefined);
      }
      if (secondClient) {
        await disconnectGatewayClient(secondClient).catch(() => undefined);
      }
      if (restartedClient) {
        await disconnectGatewayClient(restartedClient).catch(() => undefined);
      }
      if (firstServer) {
        await firstServer.close().catch(() => undefined);
      }
      if (restartedServer) {
        await restartedServer.close().catch(() => undefined);
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    }
  },
);
