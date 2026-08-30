import { once } from "node:events";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import plugin from "../../extensions/codex/index.js";
import { setRuntimeConfigSnapshot } from "../../src/config/config.js";
import { loadTranscriptEvents } from "../../src/config/sessions/session-accessor.js";
import { createGatewaySession } from "../../src/gateway/session-create-service.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../src/plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

it("adopts duplicate native titles without claiming labels or replacing local naming", async () => {
  await withOpenClawTestState({ label: "native-adoption-naming" }, async (state) => {
    const nativeHome = state.path("native-home");
    await fs.mkdir(nativeHome);
    await withEnvAsync({ CODEX_HOME: nativeHome }, async () => {
      // Only the native service is synthetic. The public plugin, real client,
      // registry, creator, SQLite history, and binding owner all execute.
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Native fixture requires a loopback port");
        }
        const config = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "openai/gpt-5.6-luna" },
            },
          },
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    transport: "websocket" as const,
                    url: `ws://127.0.0.1:${address.port}`,
                  },
                },
              },
            },
          },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const runtime = createPluginRuntime();
        const builder = createPluginRegistry({
          runtime,
          activateGlobalSideEffects: false,
          allowProcessHomeSessionCatalogs: true,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
        const rootDir = fileURLToPath(new URL("../../extensions/codex/", import.meta.url));
        const manifest = JSON.parse(await fs.readFile(`${rootDir}/openclaw.plugin.json`, "utf8"));
        const record = createPluginRecord({
          id: "codex",
          source: `${rootDir}/index.ts`,
          rootDir,
          origin: "bundled",
          enabled: true,
          configSchema: true,
          contracts: manifest.contracts,
        });
        const titles = [
          "  Shared native title  ",
          "Shared native title",
          null,
          "   ",
          "",
          ` ${"界".repeat(499)}${"🦞".repeat(300)} `,
        ];
        const threads = titles.map((name, index) => ({
          id: `01980000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
          name,
          cwd: state.workspaceDir,
          projectId: null,
          source: "cli",
          status: { type: "idle" },
          modelProvider: "openai",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          turns: [
            {
              id: `turn-${index}`,
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: `user-${index}`,
                  content: [{ type: "text", text: `Request ${index}` }],
                },
                { type: "agentMessage", id: `answer-${index}`, text: `Answer ${index}` },
              ],
            },
          ],
        }));
        server.on("connection", (socket) => {
          socket.on("message", (data) => {
            const request = JSON.parse(rawDataToString(data)) as {
              id?: number;
              method: string;
              params?: { threadId?: string };
            };
            if (request.id === undefined) {
              return;
            }
            const thread = threads.find((entry) => entry.id === request.params?.threadId);
            const result =
              request.method === "initialize"
                ? { userAgent: "openclaw/0.150.1 (test)" }
                : request.method === "thread/list"
                  ? {
                      data: threads.map((entry) => Object.assign({}, entry, { turns: [] })),
                      nextCursor: null,
                    }
                  : request.method === "thread/read" && thread
                    ? { thread }
                    : undefined;
            const response =
              result !== undefined
                ? { id: request.id, result }
                : {
                    id: request.id,
                    error: { code: -32601, message: `Unexpected native RPC: ${request.method}` },
                  };
            socket.send(JSON.stringify(response));
          });
        });
        builder.registry.plugins.push(record);
        markPluginRegistryActive(builder.registry);
        try {
          plugin.register(
            builder.createApi(record, {
              config,
              pluginConfig: config.plugins.entries.codex.config,
            }),
          );
          const provider = builder.registry.sessionCatalogs.find(
            (entry) => entry.provider.id === "codex",
          )!.provider;
          const continueThread = (threadId: string) =>
            provider.continueSession!({
              agentId: "main",
              hostId: "gateway:local",
              threadId,
              clientScopes: ["operator.admin"],
            });
          const getEntry = (sessionKey: string) =>
            runtime.agent.session.getSessionEntry({
              sessionKey,
              readConsistency: "latest",
            })!;

          // Preserve the reported order: the second same-agent adoption used to
          // fail unique-label admission after the first had durably committed.
          const first = await continueThread(threads[0]!.id);
          const second = await continueThread(threads[1]!.id);
          expect(second.sessionKey).not.toBe(first.sessionKey);
          expect(getEntry(second.sessionKey).sessionId).not.toBe(
            getEntry(first.sessionKey).sessionId,
          );
          for (const [index, result] of [first, second].entries()) {
            const entry = getEntry(result.sessionKey);
            expect(entry.displayName).toBe("Shared native title");
            expect(entry.label).toBeUndefined();
            expect(entry.initializationPending).toBeUndefined();
            const transcript = await loadTranscriptEvents({
              sessionKey: result.sessionKey,
              sessionId: entry.sessionId,
              agentId: "main",
            });
            expect(JSON.stringify(transcript)).toContain(`Answer ${index}`);
          }

          await runtime.agent.session.patchSessionEntry({
            sessionKey: first.sessionKey,
            update: () => ({ label: "Operator chosen label" }),
          });
          // Equality with the old source name cannot identify label authorship.
          await runtime.agent.session.patchSessionEntry({
            sessionKey: second.sessionKey,
            update: () => ({ label: "Shared native title" }),
          });
          for (const [index, result] of [first, second].entries()) {
            const before = getEntry(result.sessionKey);
            threads[index]!.name = "Renamed upstream";
            const reopened = await continueThread(threads[index]!.id);
            expect(reopened.sessionKey).toBe(result.sessionKey);
            expect(getEntry(result.sessionKey)).toMatchObject({
              sessionId: before.sessionId,
              label: before.label,
              displayName: "Shared native title",
              pluginExtensions: before.pluginExtensions,
            });
          }

          const explicitA = await createGatewaySession({
            cfg: config,
            key: "agent:main:explicit-a",
            label: "User duplicate",
            commandSource: "test",
            operatorRoleActor: { kind: "system" },
          });
          const explicitB = await createGatewaySession({
            cfg: config,
            key: "agent:main:explicit-b",
            label: "  User duplicate  ",
            commandSource: "test",
            operatorRoleActor: { kind: "system" },
          });
          expect(explicitA.ok).toBe(true);
          expect(explicitB).toMatchObject({
            ok: false,
            error: { code: "INVALID_REQUEST", message: "label already in use: User duplicate" },
          });

          const keys = new Set([first.sessionKey, second.sessionKey]);
          for (const thread of threads.slice(2)) {
            const result = await continueThread(thread.id);
            expect(keys.has(result.sessionKey)).toBe(false);
            keys.add(result.sessionKey);
            const entry = getEntry(result.sessionKey);
            expect(entry.label).toBeUndefined();
            expect(entry.displayName).toBe(thread.name?.trim() ? "界".repeat(499) : undefined);
          }
          expect(keys.size).toBe(titles.length);
        } finally {
          for (const { harness } of builder.registry.agentHarnesses) {
            await harness.dispose?.();
          }
          markPluginRegistryRetired(builder.registry);
        }
      } finally {
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
});
