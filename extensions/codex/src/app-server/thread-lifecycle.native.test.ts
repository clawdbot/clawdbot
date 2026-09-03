import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");
afterEach(resetThreadLifecycleTestFixtures);

describe("native Codex cold thread recovery", () => {
  it(
    "replaces a deleted ordinary binding and completes its next turn",
    { timeout: 75_000 },
    async (context) => {
      const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
      const root = await fs.realpath(tempDirs.make("codex-missing-thread-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      let requests = 0;
      const server = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          requests += 1;
          const events = [
            { type: "response.created", response: { id: "recovered-response" } },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "recovered-answer",
                content: [{ type: "output_text", text: "Recovered conversation." }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "recovered-response",
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ];
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        });
      });
      context.onTestFinished(async () => {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback provider address");
      }
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.6-luna"',
          'model_provider="recovery-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.recovery-fixture]",
          'name="Synthetic recovery provider"',
          `base_url="http://127.0.0.1:${address.port}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join("\n"),
      );
      const agentDir = path.join(root, "agent");
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const appServer = {
        ...createAppServerOptions(),
        start: {
          transport: "stdio" as const,
          command: native.command,
          commandSource: "config" as const,
          args: ["app-server"],
          cwd: native.cwd,
          headers: {},
          env: childEnv,
          clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
        },
      };
      const client = await createIsolatedCodexAppServerClient({
        startOptions: appServer.start,
        agentDir,
        authProfileId: null,
        config: {},
        timeoutMs: 20_000,
      });
      context.onTestFinished(async () => expect(await client.closeAndWait()).toBe(true));
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      const params = {
        ...createParams(path.join(root, "session.jsonl"), native.cwd),
        agentId: "main",
        agentDir,
        modelId: "gpt-5.6-luna",
      };
      const store = createPluginStateSyncKeyedStore<StoredCodexAppServerBinding>("codex", {
        namespace: "native-recovery-test",
        maxEntries: 32,
      });
      const bindingStore = createCodexAppServerBindingStore(store);
      const common = {
        client,
        bindingStore,
        params,
        cwd: native.cwd,
        dynamicTools: [],
        appServer,
        userMcpServersEnabled: false,
        signal: AbortSignal.timeout(60_000),
      };
      const first = await startOrResumeThread(common);
      await client.request("thread/inject_items", {
        threadId: first.threadId,
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Synthetic previous history." }],
          },
        ],
      });
      await client.request("thread/delete", { threadId: first.threadId });
      await expect(
        client.request("thread/read", { threadId: first.threadId, includeTurns: false }),
      ).rejects.toMatchObject({ code: -32_600 });
      const identity = sessionBindingIdentity(params);
      expect(bindingStore.read(identity)?.threadId).toBe(first.threadId);
      const recovered = await startOrResumeThread(common);
      expect(recovered.threadId).not.toBe(first.threadId);
      expect(recovered).toMatchObject({
        model: "gpt-5.6-luna",
        modelProvider: "recovery-fixture",
        lifecycle: { action: "started" },
      });
      expect(bindingStore.read(identity)?.threadId).toBe(recovered.threadId);
      const completed = createDeferred<unknown>();
      const removeHandler = client.addNotificationHandler((notification) => {
        if (
          notification.method === "turn/completed" &&
          isJsonObject(notification.params) &&
          notification.params.threadId === recovered.threadId
        ) {
          completed.resolve(notification.params.turn);
        }
      });
      context.onTestFinished(removeHandler);
      await client.request("turn/start", {
        threadId: recovered.threadId,
        input: [{ type: "text", text: "Continue the conversation.", text_elements: [] }],
      });
      await expect(completed.promise).resolves.toMatchObject({ status: "completed" });
      expect(requests).toBe(1);
      const history = await client.request("thread/read", {
        threadId: recovered.threadId,
        includeTurns: true,
      });
      expect(JSON.stringify(history.thread.turns)).toContain("Recovered conversation.");
    },
  );
});
