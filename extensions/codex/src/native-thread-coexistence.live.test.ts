import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import { createIsolatedCodexAppServerClient } from "./app-server/shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CODEX_THREAD_COEXISTENCE === "1";
const describeLive = LIVE ? describe : describe.skip;

async function withClient<T>(
  options: Parameters<typeof createIsolatedCodexAppServerClient>[0],
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const client = await createIsolatedCodexAppServerClient(options);
  try {
    return await run(client);
  } finally {
    await client.closeAndWait();
  }
}

describeLive("native Codex thread coexistence", () => {
  it("shares thread storage across independent app-server processes", async () => {
    await withTempDir("openclaw-codex-coexistence-", async (root) => {
      try {
        const codexHome = path.join(root, "codex-home");
        const agentDir = path.join(root, "agent");
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });
        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        const startOptions = {
          ...runtime.start,
          env: { CODEX_HOME: codexHome },
          clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
        };
        const clientOptions = {
          startOptions,
          agentDir,
          authProfileId: null,
          timeoutMs: 60_000,
        };

        const started = await withClient(clientOptions, async (first) => {
          const response = await first.request(
            "thread/start",
            {
              cwd: workspace,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              threadSource: "user",
            },
            { timeoutMs: 60_000 },
          );
          const turn = await first.request(
            "turn/start",
            {
              threadId: response.thread.id,
              input: [{ type: "text", text: "Cross-client visibility probe" }],
            },
            { timeoutMs: 60_000 },
          );
          let materialized = false;
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const listed = await first.request(
              "thread/list",
              {
                archived: false,
                limit: 100,
                modelProviders: [],
                sortKey: "recency_at",
                sortDirection: "desc",
                sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
              },
              { timeoutMs: 60_000 },
            );
            materialized = listed.data.some((thread) => thread.id === response.thread.id);
            if (materialized) {
              break;
            }
            await delay(100);
          }
          if (!materialized) {
            throw new Error("user turn did not materialize shared thread");
          }
          try {
            await first.request(
              "turn/interrupt",
              { threadId: response.thread.id, turnId: turn.turn.id },
              { timeoutMs: 60_000 },
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes("no active turn to interrupt")
            ) {
              throw error;
            }
          }
          await first.request(
            "thread/name/set",
            { threadId: response.thread.id, name: "OpenClaw coexistence source" },
            { timeoutMs: 60_000 },
          );
          return response;
        });

        const forked = await withClient(clientOptions, async (second) => {
          const read = await second.request(
            "thread/read",
            { threadId: started.thread.id, includeTurns: true },
            { timeoutMs: 60_000 },
          );
          expect(read.thread.id).toBe(started.thread.id);

          let listedSource;
          let listedThreads: Array<{ id: string; source?: unknown }> = [];
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const listed = await second.request(
              "thread/list",
              {
                archived: false,
                limit: 100,
                modelProviders: [],
                sortKey: "recency_at",
                sortDirection: "desc",
                sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
              },
              { timeoutMs: 60_000 },
            );
            listedThreads = listed.data;
            listedSource = listed.data.find((thread) => thread.id === started.thread.id);
            if (listedSource) {
              break;
            }
            await delay(100);
          }
          if (!listedSource) {
            throw new Error(
              `shared thread missing from list: ${JSON.stringify({
                threadId: started.thread.id,
                readSource: read.thread.source,
                listed: listedThreads.map((thread) => ({ id: thread.id, source: thread.source })),
              })}`,
            );
          }

          const response = await second.request(
            "thread/fork",
            { threadId: started.thread.id, threadSource: "user" },
            { timeoutMs: 60_000 },
          );
          expect(response.thread.id).not.toBe(started.thread.id);
          await second.request(
            "thread/name/set",
            { threadId: response.thread.id, name: "OpenClaw coexistence fork" },
            { timeoutMs: 60_000 },
          );
          await second.request(
            "thread/archive",
            { threadId: response.thread.id },
            { timeoutMs: 60_000 },
          );
          await second.request(
            "thread/unarchive",
            { threadId: response.thread.id },
            { timeoutMs: 60_000 },
          );
          return response;
        });

        await withClient(clientOptions, async (third) => {
          const finalList = await third.request(
            "thread/list",
            {
              archived: false,
              limit: 100,
              modelProviders: [],
              sortKey: "recency_at",
              sortDirection: "desc",
              sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
            },
            { timeoutMs: 60_000 },
          );
          expect(finalList.data).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: forked.thread.id,
                name: "OpenClaw coexistence fork",
              }),
            ]),
          );
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }, 120_000);
});
