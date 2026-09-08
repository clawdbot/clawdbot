import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  createCodexHarnessLiveInstance,
  createCodexHarnessEventCapture,
  readCodexNativeUsageSnapshots,
  CODEX_HARNESS_CONTEXT_EVENT_PREFIXES,
} from "../../test/helpers/gateway-codex-harness.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { withIsolatedTestHome } from "../../test/test-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";

describe("native Codex fixture boundaries", () => {
  it.each([
    { authMode: undefined, customHome: false, baseUrl: "https://example.invalid/v1" },
    { authMode: undefined, customHome: true, baseUrl: "https://example.invalid/v1" },
    { authMode: "api-key" as const, customHome: true, baseUrl: "https://example.invalid/v1" },
    { authMode: "api-key" as const, customHome: false, baseUrl: "  " },
    { authMode: "api-key" as const, customHome: true, baseUrl: " https://example.invalid/v1 " },
  ])(
    "preserves staged native home ($authMode, custom=$customHome, url=$baseUrl)",
    async ({ authMode, customHome, baseUrl }) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "codex-fixture-env-")),
      );
      const nativeHome = path.join(root, customHome ? "custom-codex" : ".codex");
      await fs.mkdir(nativeHome, { recursive: true });
      const sentinels = {
        "auth.json": '{"fixture":"not-a-credential"}\n',
        "config.toml": "# synthetic staged config\n",
      };
      for (const [name, contents] of Object.entries(sentinels)) {
        await fs.writeFile(path.join(nativeHome, name), contents);
      }
      try {
        await withEnvAsync(
          {
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "source-state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "source-config.json"),
            OPENCLAW_LIVE_TEST: "1",
            OPENCLAW_LIVE_USE_REAL_HOME: undefined,
            CODEX_HOME: customHome ? nativeHome : undefined,
            OPENAI_API_KEY: "synthetic-fixture-key",
            CODEX_API_KEY: "synthetic-codex-key",
            CEREBRAS_API_KEY: "synthetic-cerebras-key",
            GROQ_API_KEY: "synthetic-groq-key",
            OPENAI_BASE_URL: baseUrl,
          },
          async () => {
            const staged = withIsolatedTestHome({ loadProfileEnv: false });
            try {
              const callerHome = process.env.HOME;
              const instance = await createCodexHarnessLiveInstance(
                "fixture-gateway-token",
                authMode,
              );
              try {
                expect(process.env.HOME).toBe(callerHome);
                expect(instance.env.HOME).toBe(callerHome);
                expect(instance.env.USERPROFILE).toBe(process.env.USERPROFILE);
                expect(instance.env.OPENCLAW_HOME).toBe(process.env.OPENCLAW_HOME);
                expect(instance.env.CODEX_HOME).toBe(customHome ? nativeHome : undefined);
                const resolvedHome =
                  instance.env.CODEX_HOME ?? path.join(instance.env.HOME!, ".codex");
                for (const [name, contents] of Object.entries(sentinels)) {
                  expect(await fs.readFile(path.join(resolvedHome, name), "utf8")).toBe(contents);
                }
                expect(instance.env.OPENAI_API_KEY).toBe(
                  authMode === "api-key" ? "synthetic-fixture-key" : undefined,
                );
                expect(instance.env.CODEX_API_KEY).toBeUndefined();
                expect(instance.env.CEREBRAS_API_KEY).toBeUndefined();
                expect(instance.env.GROQ_API_KEY).toBeUndefined();
                expect(instance.env.OPENAI_BASE_URL).toBe(
                  authMode === "api-key" && baseUrl.trim() ? baseUrl : undefined,
                );
                expect(instance.stateDir.startsWith(instance.state.root + path.sep)).toBe(true);
                expect(instance.configPath.startsWith(instance.state.root + path.sep)).toBe(true);
                expect(instance.state.workspaceDir.startsWith(instance.state.root + path.sep)).toBe(
                  true,
                );
                expect(instance.stateDir.startsWith(staged.tempHome + path.sep)).toBe(false);
                instance.state.applyEnv();
                expect(process.env.HOME).toBe(callerHome);
                expect(process.env.OPENCLAW_STATE_DIR).toBe(instance.stateDir);
              } finally {
                await instance.cleanup();
              }
              expect(process.env.HOME).toBe(callerHome);
            } finally {
              staged.cleanup();
            }
          },
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("retains full-context usage through the request capture and snapshot reader", () => {
    const capture = createCodexHarnessEventCapture({
      sessionKey: "session-a",
      eventPrefixes: CODEX_HARNESS_CONTEXT_EVENT_PREFIXES,
    });
    capture.start(100);
    const usage = {
      activeContextTokens: 300_010,
      promptTokens: 300_000,
      modelContextWindow: 875_900,
      cachedInputTokens: 250_000,
      cacheWriteInputTokens: 5_000,
      inputTokens: 300_000,
      outputTokens: 10,
    };
    const emit = (stream: string, data: Record<string, unknown>, sessionKey = "session-a") =>
      capture.onAgentEvent({ runId: "run-a", seq: 1, ts: 125, stream, data, sessionKey });
    emit("assistant", { text: "first" }, "session-b");
    expect(capture.firstAssistantMs).toBeUndefined();
    emit("assistant", { text: "first" });
    emit("codex_app_server.lifecycle", { phase: "turn_starting" });
    emit("codex_app_server.guardian", { phase: "completed", status: "approved" });
    emit("compaction", { phase: "end", completed: true });
    emit("usage", usage, "session-b");
    emit("tool", { phase: "result" });
    emit("usage", usage);
    expect(readCodexNativeUsageSnapshots(capture.events)).toEqual([usage]);
    expect(capture.events.map(({ stream }) => stream)).toEqual([
      "codex_app_server.lifecycle",
      "codex_app_server.guardian",
      "compaction",
      "usage",
    ]);
    expect(capture.firstAssistantMs).toBe(25);
    const guardian = createCodexHarnessEventCapture({
      sessionKey: "session-a",
      includeAllSessions: true,
    });
    guardian.onAgentEvent({
      runId: "run-b",
      seq: 1,
      ts: 200,
      stream: "codex_app_server.guardian",
      sessionKey: "session-b",
      data: { phase: "completed" },
    });
    expect(guardian.events).toHaveLength(1);
  });
});

async function writeNativeCodexRollout(codexHome: string) {
  const threadId = randomUUID();
  const title = `Native catalog ${randomUUID()}`;
  const timestamp = "2026-09-07T12:00:00.000Z";
  const directory = path.join(codexHome, "sessions", "2026", "09", "07");
  const rollout = path.join(directory, `rollout-2026-09-07T12-00-00-${threadId}.jsonl`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    rollout,
    [
      {
        timestamp,
        type: "session_meta",
        payload: {
          session_id: threadId,
          id: threadId,
          timestamp,
          cwd: path.dirname(codexHome),
          originator: "codex_cli_rs",
          cli_version: "test",
          source: "cli",
          model_provider: "openai",
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: title }],
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "user_message", message: title, kind: "plain" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return { threadId, title };
}

describe("Gateway Codex native catalog", () => {
  it("lets admins list, exact-title search, and read an isolated process-HOME thread", async () => {
    const token = `catalog-${randomUUID()}`;
    const instance = await createOpenClawTestInstance({
      name: "codex-native-catalog",
      gatewayToken: token,
      state: { layout: "split" },
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
      config: {
        gateway: { mode: "local" },
        plugins: {
          allow: ["codex"],
          entries: {
            codex: { enabled: true, config: { appServer: { homeScope: "user" } } },
          },
        },
      },
    });
    let admin: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    let reader: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    try {
      const native = await writeNativeCodexRollout(path.join(instance.homeDir, ".codex"));
      await instance.startGateway();
      admin = await connectTestGatewayClient({
        url: instance.url,
        token,
        scopes: ["operator.admin", "operator.read"],
      });
      const listed = await admin.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
      });
      const nativeHost = listed.catalogs[0]?.hosts.find((host) =>
        host.sessions.some((session) => session.threadId === native.threadId),
      );
      expect(nativeHost).toBeDefined();

      const searched = await admin.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
        search: native.title,
      });
      expect(
        searched.catalogs.flatMap((catalog) =>
          catalog.hosts.flatMap((host) => host.sessions.map((session) => session.threadId)),
        ),
      ).toContain(native.threadId);

      const transcript = await admin.request<SessionsCatalogReadResult>("sessions.catalog.read", {
        catalogId: "codex",
        agentId: "main",
        hostId: nativeHost!.hostId,
        threadId: native.threadId,
        sourceHomeId: nativeHost!.sessions.find((session) => session.threadId === native.threadId)
          ?.sourceHomeId,
      });
      expect(transcript.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: native.title })]),
      );

      reader = await connectTestGatewayClient({
        url: instance.url,
        token,
        scopes: ["operator.read"],
      });
      const readerList = await reader.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
      });
      expect(
        readerList.catalogs.flatMap((catalog) =>
          catalog.hosts.flatMap((host) => host.sessions.map((session) => session.threadId)),
        ),
      ).not.toContain(native.threadId);
      await expect(
        reader.request("sessions.catalog.read", {
          catalogId: "codex",
          agentId: "main",
          hostId: nativeHost!.hostId,
          threadId: native.threadId,
        }),
      ).rejects.toThrow("local Codex sessions are unavailable in isolated state");
    } finally {
      await reader?.stopAndWait().catch(() => undefined);
      await admin?.stopAndWait().catch(() => undefined);
      await instance.cleanup();
    }
  }, 120_000);
});
