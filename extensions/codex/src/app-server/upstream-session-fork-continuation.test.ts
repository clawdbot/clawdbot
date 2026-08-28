import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexCatalogHomeResolver } from "../session-catalog-homes.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  buildCodexAppServerConnectionFingerprint,
  replaceCodexCatalogConnectionHomes,
} from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle.js";
import { importCodexThreadHistoryToTranscript } from "./transcript-mirror.js";
import {
  createForkTestRuntime,
  forkControl,
  forkParams,
  forkResponse,
  codexForkTurn,
} from "./upstream-session-fork.test-support.js";

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLink: vi.fn(),
  upsertSessionUpstreamLink: vi.fn(() => true),
}));

import { forkCodexUpstreamSession } from "./upstream-session-fork.js";

describe("persistent upstream fork continuation", () => {
  it("continues a persistent upstream fork on its secondary home and native model with applied harness configuration", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-fork-home-")));
    const agentDir = path.join(root, "agents", "main", "agent");
    const sourceAgentDir = path.join(root, "agents", "source", "agent");
    const secondaryHome = resolveCodexAppServerHomeDir(sourceAgentDir);
    const env = { HOME: root, CODEX_HOME: path.join(root, "primary-codex-home") };
    const pluginConfig = {
      supervision: { enabled: true },
      appServer: { approvalsReviewer: "user" },
    };
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        list: [
          { id: "main", agentDir },
          { id: "source", agentDir: sourceAgentDir },
        ],
      },
      session: { store: path.join(root, "openclaw-agent.sqlite") },
    };
    const params = forkParams();
    const retained = codexForkTurn("turn-1", "one");
    const sourceTurns = [retained, codexForkTurn("turn-2", "edit me")];
    const nativeModel = "gpt-5.6-luna";
    const responseFor = (threadId: string, model = nativeModel) => {
      const response = forkResponse(threadId);
      return {
        ...response,
        cwd: root,
        model,
        thread: {
          ...response.thread,
          cwd: root,
          ephemeral: false,
          status: { type: "idle" as const },
          turns: threadId === "thread-source" ? sourceTurns : [retained],
        },
      };
    };
    const nativeThreads = new Map([
      ["thread-source", responseFor("thread-source")],
      ["thread-forked", responseFor("thread-forked")],
    ]);
    const sourceBefore = structuredClone(nativeThreads.get("thread-source"));
    let nextThreadId = 0;
    const clients: ReturnType<typeof createFakeCodexAppServerClient>[] = [];
    const createClient = (home: "secondary" | "ordinary") => {
      const client = createFakeCodexAppServerClient(async (method, requestParams) => {
        if (method === "skills/list") {
          return { data: [] };
        }
        if (!isJsonObject(requestParams)) {
          throw new Error(`Expected object params for ${method}`);
        }
        if (method === "thread/start") {
          const response = responseFor(
            `thread-${home}-${nextThreadId++}`,
            typeof requestParams.model === "string" ? requestParams.model : nativeModel,
          );
          response.thread.turns = [];
          nativeThreads.set(response.thread.id, response);
          return response;
        }
        const { threadId } = requestParams;
        if (typeof threadId !== "string") {
          throw new Error(`Expected string threadId for ${method}`);
        }
        if (method === "thread/read" || method === "thread/resume") {
          const response = nativeThreads.get(threadId);
          if (home !== "secondary" || !response) {
            throw new Error(`Thread is not in the selected Codex home: ${threadId}`);
          }
          return response;
        }
        if (method === "thread/fork") {
          const { lastTurnId } = requestParams;
          if (lastTurnId != null && typeof lastTurnId !== "string") {
            throw new Error("Expected string lastTurnId when provided for thread/fork");
          }
          const source = nativeThreads.get(threadId);
          if (home !== "secondary" || !source) {
            throw new Error(`No stored fork source in the selected Codex home: ${threadId}`);
          }
          const response = responseFor(
            `thread-${home}-${nextThreadId++}`,
            typeof requestParams.model === "string" ? requestParams.model : nativeModel,
          );
          const turns = source.thread.turns;
          const boundaryIndex = turns.findIndex((turn) => turn.id === lastTurnId);
          if (lastTurnId != null && boundaryIndex < 0) {
            throw new Error(`Unknown persisted lastTurnId: ${lastTurnId}`);
          }
          response.thread.turns =
            lastTurnId != null ? turns.slice(0, boundaryIndex + 1) : [...turns];
          nativeThreads.set(response.thread.id, response);
          return response;
        }
        if (method === "thread/archive") {
          if (home !== "secondary" || !nativeThreads.has(threadId)) {
            throw new Error(`Unknown archive target: ${threadId}`);
          }
          nativeThreads.delete(threadId);
          return {};
        }
        if (method === "thread/inject_items") {
          if (
            home !== "secondary" ||
            !nativeThreads.has(threadId) ||
            !Array.isArray(requestParams.items) ||
            requestParams.items.length === 0
          ) {
            throw new Error(`Invalid history injection: ${threadId}`);
          }
          // Raw ResponseItems persist without TurnStarted boundaries. Do not
          // fabricate native turns that could make a later beforeTurnId cut pass.
          return {};
        }
        throw new Error(`Unexpected Codex request: ${method}`);
      });
      const instanceId = `${home}-client-${clients.length}`;
      client.client.getInstanceId = () => instanceId;
      clients.push(client);
      return client;
    };
    try {
      await Promise.all(
        [agentDir, secondaryHome, env.CODEX_HOME].map((dir) => fs.mkdir(dir, { recursive: true })),
      );
      const sourceHome = createCodexCatalogHomeResolver({
        config,
        getRuntimeConfig: () => config,
        getPluginConfig: () => pluginConfig,
        env,
      })
        .forAgent("main")
        .find((home) => home.appServer.start.env?.CODEX_HOME === secondaryHome);
      expect(sourceHome).toBeDefined();
      const fingerprint = buildCodexAppServerConnectionFingerprint(sourceHome!.appServer, agentDir);
      params.upstream.ref = { connectionFingerprint: fingerprint, threadId: "thread-source" };
      params.source.storePath = config.session!.store!;
      await upsertSessionEntry({
        ...params.source,
        entry: { sessionId: params.source.sessionId, updatedAt: 1 },
      });
      await importCodexThreadHistoryToTranscript({
        ...params.source,
        thread: nativeThreads.get("thread-source")!.thread,
        throughTurnId: "turn-2",
      });
      const sourceEntries = await readVisibleSessionTranscriptMessageEntries(params.source);
      params.source.entryId = sourceEntries.findLast((entry) => entry.role === "user")!.entryId;
      const secondary = forkControl(
        vi.fn(async () => responseFor("thread-forked")),
        fingerprint,
      );
      secondary.control.readThread = async (threadId) => nativeThreads.get(threadId)!.thread;
      secondary.control.listTurnPage = async ({ threadId }) => ({
        data: nativeThreads.get(threadId)!.thread.turns,
      });
      const primary = forkControl(undefined, "primary-fingerprint");
      const controlFactory = {
        ...primary.controlFactory,
        forUpstream: secondary.controlFactory.forUpstream.bind(secondary.controlFactory),
      };
      const ordinary = createClient("ordinary");
      const native = createClient("secondary");
      secondary.control.clientId = native.client.getInstanceId();
      const state = createCodexTestBindingStateStore();
      const bindingStore = createCodexAppServerBindingStore(state);
      const runtime = createForkTestRuntime(params.source.storePath);

      await expect(
        forkCodexUpstreamSession(params, {
          bindingStore,
          controlFactory,
          harnessRuntimeId: "codex",
          resolveConfig: () => config,
          runtime,
        }),
      ).resolves.toMatchObject({ status: "created", key: params.targetKey });
      expect(primary.forkThread).not.toHaveBeenCalled();
      expect(secondary.forkThread).toHaveBeenCalledOnce();
      const created = await vi.mocked(runtime.agent.session.createSessionEntry).mock.results[0]!
        .value;
      const identity = sessionBindingIdentity({
        agentId: "main",
        sessionId: created.sessionId,
        sessionKey: created.key,
        config,
      });
      const attempt = {
        agentId: "main",
        agentDir,
        config,
        sessionId: created.sessionId,
        sessionKey: created.key,
        workspaceDir: root,
        runId: "fork-continuation",
        prompt: "edited request",
        provider: "codex",
        modelId: "gpt-5.5",
        model: { ...createCodexTestModel("codex"), id: "gpt-5.5", name: "gpt-5.5" },
        hostCapabilities: createCodexTestHostCapabilities(),
        authProfileId: "openai:ordinary",
        authProfileStore: { version: 1, profiles: {} },
        timeoutMs: 5_000,
      } as EmbeddedRunAttemptParams;
      const dynamicTools = [
        {
          type: "function" as const,
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object", properties: {} },
        },
      ];
      const developerInstructions = "Follow the child agent's current instructions.";
      const continueFork = async (store: CodexAppServerBindingStore, nativeClient = native) => {
        const connection = resolveCodexBindingAppServerConnection({
          binding: await store.read(identity),
          pluginConfig,
          config,
          agentDir,
          env,
          authProfileId: attempt.authProfileId,
          requirementsToml: null,
        });
        const selectedFingerprint = buildCodexAppServerConnectionFingerprint(
          connection.appServer,
          agentDir,
        );
        const selected = selectedFingerprint === fingerprint ? nativeClient : ordinary;
        const binding = await startOrResumeThread({
          bindingStore: store,
          client: selected.client,
          params: { ...attempt, authProfileId: connection.requestAuthProfileId },
          cwd: root,
          appServer: connection.appServer,
          dynamicTools,
          developerInstructions,
          userMcpServersEnabled: false,
          hostSystemAgentActive: false,
        });
        return { binding, connection };
      };
      const first = await continueFork(bindingStore);

      expect(first.connection.appServer.start.env?.CODEX_HOME).toBe(secondaryHome);
      expect(first.connection.clientAuthProfileId).toBeNull();
      expect(ordinary.request).not.toHaveBeenCalled();
      expect(first.binding).toMatchObject({
        model: nativeModel,
        modelProvider: "openai",
        preserveNativeModel: true,
      });
      // Configuration must reach thread/start; persisted fingerprints alone cannot install tools.
      expect(native.request).toHaveBeenCalledWith(
        "thread/start",
        expect.objectContaining({
          model: nativeModel,
          modelProvider: "openai",
          dynamicTools,
          developerInstructions,
        }),
        expect.anything(),
      );
      expect(native.request).toHaveBeenCalledWith(
        "thread/inject_items",
        {
          threadId: first.binding.threadId,
          items: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
          ],
        },
        expect.anything(),
      );

      const nextClient = createClient("secondary");
      nextClient.request.mockClear();
      const second = await continueFork(createCodexAppServerBindingStore(state), nextClient);
      expect(second.binding.threadId).toBe(first.binding.threadId);
      expect(second.binding.model).toBe(nativeModel);
      expect(second.connection.appServer.start.env?.CODEX_HOME).toBe(secondaryHome);
      expect(ordinary.request).not.toHaveBeenCalled();
      expect(nextClient.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
        false,
      );
      const resume = nextClient.request.mock.calls.find(([method]) => method === "thread/resume");
      expect(resume?.[1]).toMatchObject({ threadId: first.binding.threadId });
      expect(resume?.[1]).not.toHaveProperty("model");
      expect(resume?.[1]).not.toHaveProperty("modelProvider");
      expect(nativeThreads.get("thread-source")).toEqual(sourceBefore);
      expect(secondary.archiveThread).not.toHaveBeenCalledWith("thread-source");
    } finally {
      for (const client of clients) {
        client.close();
      }
      replaceCodexCatalogConnectionHomes([]);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
