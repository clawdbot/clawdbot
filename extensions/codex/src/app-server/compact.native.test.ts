// Native regression proof: the manual-compaction producer records the
// post-compaction usage boundary from a REAL codex app-server compaction.
//
// The pinned @openai/codex 0.153.4 binary runs with an isolated CODEX_HOME and
// a loopback model provider; the production manual-compaction path
// (compact.ts maybeCompactCodexAppServerSession) drives a real
// thread/compact/start and consumes the real notification stream. Codex's
// recompute zeroes the input/output split and reports the estimated compacted
// context in totalTokens; the changed boundary normalization must record that
// recomputed total as the available contextUsage (never a zero prompt count),
// so transcript-derived session usage cannot resurrect the stale pre-compaction
// count after compaction.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { maybeCompactCodexAppServerSession } from "./compact.js";
import * as compactionActivity from "./context-compaction-activity.js";
import type { CodexCompactionUsageAfter } from "./context-compaction-activity.js";
import { resolveCodexCompactionContextUsageAfter } from "./event-projector-usage.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

let tempRoot: string;

beforeEach(async () => {
  resetCodexTestBindingStore();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-compact-"));
});

afterEach(async () => {
  // The app-server child can still be draining its CODEX_HOME after close.
  await fs
    .rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    .catch(() => fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }));
});

describe("native codex compaction usage boundary", () => {
  it(
    "records the recomputed context total from a real native compaction",
    { timeout: 180_000 },
    async (context) => {
      const native = await createCodexNativeTestState(tempRoot);
      for (const [name, value] of Object.entries(native.env)) {
        if (value !== undefined) {
          vi.stubEnv(name, value);
        }
      }
      const agentDir = path.join(tempRoot, "agent");
      const server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          if (request.url !== "/v1/responses" || request.method !== "POST") {
            response.writeHead(404).end();
            return;
          }
          let parsed: JsonObject;
          try {
            parsed = JSON.parse(body) as JsonObject;
          } catch {
            response.writeHead(400).end();
            return;
          }
          const events = [
            { type: "response.created", response: { id: "native-compact-response" } },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "native-compact-answer",
                content: [{ type: "output_text", text: "Completion." }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "native-compact-response",
                usage: { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 },
              },
            },
          ];
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
          void parsed;
        });
      });
      context.onTestFinished(async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback provider address");
      }
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.6-luna"',
          'model_provider="native-compact-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="workspace-write"',
          "allow_login_shell=false",
          "model_context_window=4096",
          "[features]",
          "shell_snapshot=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.native-compact-fixture]",
          'name="Native compaction provider"',
          `base_url="http://127.0.0.1:${address.port}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const startOptions = {
        transport: "stdio" as const,
        command: native.command,
        commandSource: "config" as const,
        args: ["app-server"],
        cwd: native.cwd,
        headers: {},
        env: childEnv,
        clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
      };
      const client = await createIsolatedCodexAppServerClient({
        startOptions,
        agentDir,
        authProfileId: null,
        config: {},
        timeoutMs: 30_000,
      });
      context.onTestFinished(async () => {
        await client.closeAndWait().catch(() => {});
      });
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      ensureCodexAppServerClientRuntime(client, { agentDir });
      const thread = (await client.request(
        "thread/start",
        {
          cwd: native.cwd,
          model: "gpt-5.6-luna",
          modelProvider: "native-compact-fixture",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          ephemeral: true,
        },
        { timeoutMs: 60_000 },
      )) as { thread: { id: string } };
      const threadId = thread.thread.id;
      // Seed synthetic history so the compaction recompute has a real
      // pre-compaction context to replace.
      for (let i = 0; i < 6; i += 1) {
        await client.request(
          "thread/inject_items",
          {
            threadId,
            items: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `Synthetic user message ${i}.` }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: `Synthetic assistant reply ${i}.` }],
              },
            ],
          },
          { timeoutMs: 60_000 },
        );
      }
      // A live session owns the thread; compaction keeps that ownership.
      expect(await retainCodexAppServerLiveThread(client, threadId)).toBe(true);
      const sessionFile = path.join(tempRoot, "session.jsonl");
      const sessionKey = "agent:main:session-1";
      registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey);
      seedCodexTestBinding(sessionFile, { threadId, cwd: native.cwd });
      const persistActivity = vi.spyOn(compactionActivity, "persistCodexContextCompactionActivity");
      // Record the raw compaction-window tokenUsage notifications.
      let compactionOpen = false;
      const windowLastSnapshots: Array<JsonObject | undefined> = [];
      const removeHandler = client.addNotificationHandler((notification) => {
        const params = notification.params;
        if (!isJsonObject(params)) {
          return;
        }
        if (notification.method === "item/started") {
          const item = params.item;
          if (isJsonObject(item) && item.type === "contextCompaction") {
            compactionOpen = true;
          }
          return;
        }
        if (notification.method === "thread/tokenUsage/updated" && compactionOpen) {
          const tokenUsage = params.tokenUsage;
          const last =
            isJsonObject(tokenUsage) && isJsonObject(tokenUsage.last)
              ? (tokenUsage.last as JsonObject)
              : undefined;
          windowLastSnapshots.push(last);
          return;
        }
        if (notification.method === "item/completed") {
          const item = params.item;
          if (isJsonObject(item) && item.type === "contextCompaction") {
            compactionOpen = false;
          }
        }
      });
      context.onTestFinished(removeHandler);

      const result = await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey,
          sessionFile,
          workspaceDir: native.cwd,
          trigger: "manual",
        },
        {
          bindingStore: testCodexAppServerBindingStore,
          clientFactory: async () => client,
        },
      );
      expect(result).toMatchObject({ ok: true, compacted: true });
      const tokensAfter = (result as { result?: { tokensAfter?: number } }).result?.tokensAfter;
      const persistArgs = persistActivity.mock.calls.map(
        (call) => call[0] as { threadId?: string; usageAfter?: unknown },
      );
      expect(persistArgs).toHaveLength(1);
      const usageAfter = persistArgs[0]?.usageAfter as CodexCompactionUsageAfter | undefined;
      expect(usageAfter).toMatchObject({
        state: "available",
        promptTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      });
      const availableUsageAfter = usageAfter?.state === "available" ? usageAfter : undefined;
      expect(availableUsageAfter?.promptTokens).toBeGreaterThan(0);
      expect(availableUsageAfter?.totalTokens).toBeGreaterThan(0);
      // The outward tokensAfter result and the persisted boundary share one
      // source of truth (the compaction-window snapshot).
      expect(tokensAfter).toBe(availableUsageAfter?.totalTokens);
      // The real stream must contain the codex recompute payload this fix
      // normalizes: a zeroed input/output split with a positive totalTokens
      // estimate of the compacted context.
      const zeroInputRecompute = windowLastSnapshots.find(
        (last) =>
          last !== undefined &&
          typeof last.totalTokens === "number" &&
          last.totalTokens > 0 &&
          (last.inputTokens === 0 || last.inputTokens === undefined) &&
          last.outputTokens === 0,
      );
      expect(zeroInputRecompute).toBeDefined();
      // The recorded boundary equals resolve() over the last reliable
      // compaction-window snapshot; a zero prompt count is never recorded as a
      // positive boundary (transcript readers require a positive prompt side).
      const expected = windowLastSnapshots.reduce<CodexCompactionUsageAfter | undefined>(
        (latest, last) => {
          if (!last) {
            return latest;
          }
          const snapshot = {
            ...(typeof last.totalTokens === "number" && last.totalTokens > 0
              ? { activeContextTokens: Math.floor(last.totalTokens) }
              : {}),
            ...(typeof last.inputTokens === "number" && last.inputTokens > 0
              ? { promptTokens: Math.floor(last.inputTokens) }
              : {}),
          };
          return resolveCodexCompactionContextUsageAfter(snapshot) ?? latest;
        },
        undefined,
      );
      expect(expected).toEqual(availableUsageAfter);
    },
  );
});
