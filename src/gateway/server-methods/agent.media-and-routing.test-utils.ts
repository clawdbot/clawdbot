// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  getAgentTestMocks,
  makeContext,
  type AgentHandlerArgs,
  type AgentParams,
  type AgentCommandCall,
  setDateOnlyFakeClockActive,
  waitForAssertion,
  expectRecordFields,
  expectStringFieldContains,
  expectSqliteSessionFileMarkerForEntry,
  mockCallArg,
  expectRespondError,
  mockMainSessionEntry,
  buildExistingMainStoreEntry,
  setupNewYorkTimeConfig,
  resetTimeConfig,
  primeMainAgentRun,
  runMainAgentAndCaptureEntry,
  backendGatewayClient,
  cronContinuationGatewayClient,
  cronMediaCompletionEvent,
  setupCronContinuationReleaseFixture,
  invokeGatewaySuspendPrepare,
  operatorWriteGatewayClient,
  waitForAgentCommandCall,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("recovers a failed session when its default transcript exists", async () => {
    const now = Date.parse("2026-05-18T09:49:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-failed-default-session-file-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(`${sessionsDir}/failed-present-default-session-id.jsonl`, "", "utf8");
      const failedEntryWithDefaultTranscript = {
        sessionId: "failed-present-default-session-id",
        status: "failed",
        startedAt: now - 1_000,
        endedAt: now,
        runtimeMs: 1_000,
        abortedLastRun: true,
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: failedEntryWithDefaultTranscript,
        canonicalKey: "agent:main:main",
      });

      const capturedEntry = await runMainAgentAndCaptureEntry(
        "test-idem-failed-present-default-transcript",
      );

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("failed-present-default-session-id");
      expect(capturedEntry?.sessionId).toBe("failed-present-default-session-id");
      expect(capturedEntry?.status).toBeUndefined();
      expect(capturedEntry?.startedAt).toBeUndefined();
      expect(capturedEntry?.endedAt).toBeUndefined();
      expect(capturedEntry?.runtimeMs).toBeUndefined();
      expect(capturedEntry?.abortedLastRun).toBeUndefined();
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    });
  });

  it.each([
    {
      name: "default transcript",
      sessionKey: "agent:main:telegram:group:stale-failed",
      sessionId: "stale-failed-session-id",
      configureTranscript: async (params: { sessionId: string; sessionsDir: string }) => {
        await fs.writeFile(`${params.sessionsDir}/${params.sessionId}.jsonl`, "", "utf8");
        return {};
      },
      expectsSqliteStats: false,
    },
    {
      name: "SQLite transcript marker",
      sessionKey: "agent:main:telegram:group:stale-failed-sqlite",
      sessionId: "stale-failed-sqlite-session-id",
      configureTranscript: async (params: { sessionId: string; storePath: string }) => {
        mocks.readTranscriptStatsSync.mockReturnValue({
          eventCount: 1,
          maxSeq: 1,
          sizeBytes: 32,
        });
        return { sessionFile: `sqlite:main:${params.sessionId}:${params.storePath}` };
      },
      expectsSqliteStats: true,
    },
  ])("recovers a stale failed session when its $name exists", async (scenario) => {
    const now = Date.parse("2026-05-18T09:49:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-stale-failed-session-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      const storePath = `${sessionsDir}/sessions.json`;
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptFields = await scenario.configureTranscript({
        sessionId: scenario.sessionId,
        sessionsDir,
        storePath,
      });
      const failedEntryWithStaleActivity = {
        sessionId: scenario.sessionId,
        ...transcriptFields,
        status: "failed",
        startedAt: now - 11 * 60_000,
        endedAt: now - 10 * 60_000,
        runtimeMs: 60_000,
        abortedLastRun: true,
        updatedAt: now - 10 * 60_000,
        sessionStartedAt: now - 20 * 60_000,
        lastInteractionAt: now - 10 * 60_000,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: { session: { idleMinutes: 5 } },
        storePath,
        entry: failedEntryWithStaleActivity,
        canonicalKey: scenario.sessionKey,
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [scenario.sessionKey]: { ...failedEntryWithStaleActivity },
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent({
        message: "recover stale failed",
        agentId: "main",
        sessionKey: scenario.sessionKey,
        idempotencyKey: `test-idem-${scenario.sessionId}`,
      } as AgentParams);

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe(scenario.sessionId);
      if (scenario.expectsSqliteStats) {
        expect(mocks.readTranscriptStatsSync).toHaveBeenCalledWith({
          agentId: "main",
          sessionId: scenario.sessionId,
          sessionKey: scenario.sessionKey,
          storePath,
          sessionEntry: failedEntryWithStaleActivity,
        });
      } else {
        expect(mocks.readTranscriptStatsSync).not.toHaveBeenCalled();
      }
      expect(capturedEntry?.sessionId).toBe(scenario.sessionId);
      expect(capturedEntry?.status).toBeUndefined();
      expect(capturedEntry?.startedAt).toBeUndefined();
      expect(capturedEntry?.endedAt).toBeUndefined();
      expect(capturedEntry?.runtimeMs).toBeUndefined();
      expect(capturedEntry?.abortedLastRun).toBeUndefined();
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    });
  });

  it("recovers a failed session when its relative transcript resolves and exists", async () => {
    const now = Date.parse("2026-05-18T09:50:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-failed-session-file-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(`${sessionsDir}/relative-present.jsonl`, "", "utf8");
      const failedEntryWithResolvedTranscript = {
        sessionId: "failed-present-session-id",
        sessionFile: "relative-present.jsonl",
        status: "failed",
        startedAt: now - 1_000,
        endedAt: now,
        runtimeMs: 1_000,
        abortedLastRun: true,
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: failedEntryWithResolvedTranscript,
        canonicalKey: "agent:main:main",
      });

      const capturedEntry = await runMainAgentAndCaptureEntry(
        "test-idem-failed-present-transcript",
      );

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("failed-present-session-id");
      expect(capturedEntry?.sessionId).toBe("failed-present-session-id");
      expect(capturedEntry?.status).toBeUndefined();
      expect(capturedEntry?.startedAt).toBeUndefined();
      expect(capturedEntry?.endedAt).toBeUndefined();
      expect(capturedEntry?.runtimeMs).toBeUndefined();
      expect(capturedEntry?.abortedLastRun).toBeUndefined();
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
    });
  });

  it("keeps stored group metadata when a trusted group session receives caller-supplied selectors", async () => {
    const sessionKey = "agent:main:slack:group:C123";
    const existingEntry = buildExistingMainStoreEntry({
      channel: "slack",
      groupId: "C123",
      groupChannel: "#trusted",
      space: "TTRUSTED",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "trusted group turn",
        agentId: "main",
        sessionKey,
        channel: "slack",
        groupId: "C123",
        groupChannel: "#forged-admin",
        groupSpace: "TFORGED",
        idempotencyKey: "trusted-group-forged-selectors",
      },
      { reqId: "trusted-group-forged-selectors" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.groupId).toBe("C123");
    expect(capturedEntry?.groupChannel).toBe("#trusted");
    expect(capturedEntry?.space).toBe("TTRUSTED");
    const callArgs = await waitForAgentCommandCall<{
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    }>();
    expect(callArgs.groupChannel).toBe("#trusted");
    expect(callArgs.groupSpace).toBe("TTRUSTED");
    expect(callArgs.runContext?.groupChannel).toBe("#trusted");
    expect(callArgs.runContext?.groupSpace).toBe("TTRUSTED");
  });

  it("persists first-turn group selectors for a trusted new group session", async () => {
    const sessionKey = "agent:main:slack:group:C123";
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: capturedEntry,
      canonicalKey: sessionKey,
    }));

    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "first trusted group turn",
        agentId: "main",
        sessionKey,
        channel: "slack",
        groupId: "C123",
        groupChannel: "#general",
        groupSpace: "TWORKSPACE",
        idempotencyKey: "trusted-group-first-turn-selectors",
      },
      { reqId: "trusted-group-first-turn-selectors" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.groupId).toBe("C123");
    expect(capturedEntry?.groupChannel).toBe("#general");
    expect(capturedEntry?.space).toBe("TWORKSPACE");
    const callArgs = await waitForAgentCommandCall<{
      groupChannel?: string;
      groupSpace?: string;
      runContext?: { groupChannel?: string; groupSpace?: string };
    }>();
    expect(callArgs.groupChannel).toBe("#general");
    expect(callArgs.groupSpace).toBe("TWORKSPACE");
    expect(callArgs.runContext?.groupChannel).toBe("#general");
    expect(callArgs.runContext?.groupSpace).toBe("TWORKSPACE");
  });

  it("tags newly-created plugin runtime sessions with the plugin owner", async () => {
    const sessionKey = "agent:main:dreaming-narrative-light-workspace-1";
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: capturedEntry,
      canonicalKey: sessionKey,
    }));

    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "write a narrative",
        sessionKey,
        idempotencyKey: "plugin-runtime-owner",
      },
      {
        client: {
          internal: {
            pluginRuntimeOwnerId: "memory-core",
          },
        } as never,
      },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry?.pluginOwnerId).toBe("memory-core");
  });

  it("does not claim stale pre-existing sessions for plugin runtime cleanup", async () => {
    const sessionKey = "agent:main:existing-user-session";
    const existingEntry = {
      sessionId: "stale-session",
      updatedAt: 1,
      pluginOwnerId: "other-plugin",
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: existingEntry,
      canonicalKey: sessionKey,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [sessionKey]: { ...existingEntry },
      };
      const result = await updater(store);
      capturedEntry = store[sessionKey] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "write a narrative",
        sessionKey,
        idempotencyKey: "plugin-runtime-existing-owner",
      },
      {
        client: {
          internal: {
            pluginRuntimeOwnerId: "memory-core",
          },
        } as never,
      },
    );

    expect(capturedEntry?.pluginOwnerId).toBe("other-plugin");
  });

  it("forwards provider and model overrides for admin-scoped callers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override",
      },
      {
        reqId: "test-idem-model-override",
        client: {
          connect: {
            scopes: ["operator.admin"],
          },
        } as AgentHandlerArgs["client"],
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("forwards explicit ACP turn source markers", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "bootstrap ACP child",
        agentId: "main",
        sessionKey: "agent:main:main",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-turn-source",
      },
      { reqId: "test-acp-turn-source" },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      acpTurnSource: "manual_spawn",
    });
  });

  it("does not bypass image support check for non-ACP sessions with acpTurnSource", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey: "agent:main:main",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-image-bypass-guard",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: Buffer.from("fake-png-data").toString("base64"),
          },
        ],
      },
      { respond, reqId: "test-acp-image-bypass-guard" },
    );

    // Non-ACP session (agent:main:main) with acpTurnSource="manual_spawn" must
    // NOT bypass resolveGatewayModelSupportsImages. The image should be rejected
    // by the normal image-support check since this is not an ACP session.
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "does not accept image inputs");
  });

  it("does not bypass image support check for ACP-shaped sessions without ACP metadata", async () => {
    mockMainSessionEntry({ sessionId: "existing-acp-shaped-session" });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey: "agent:main:acp:missing-meta",
        acpTurnSource: "manual_spawn",
        idempotencyKey: "test-acp-image-metadata-bypass-guard",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: Buffer.from("fake-png-data").toString("base64"),
          },
        ],
      },
      { respond, reqId: "test-acp-image-metadata-bypass-guard" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "does not accept image inputs");
  });

  it("rejects provider and model overrides for write-scoped callers", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-write",
      },
      {
        reqId: "test-idem-model-override-write",
        client: {
          connect: {
            scopes: ["operator.write"],
          },
        } as AgentHandlerArgs["client"],
        respond,
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRespondError(respond, {
      message: "provider/model overrides are not authorized for this caller.",
    });
  });

  it("forwards provider and model overrides when internal override authorization is set", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "test override",
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        idempotencyKey: "test-idem-model-override-internal",
      },
      {
        reqId: "test-idem-model-override-internal",
        client: {
          connect: {
            scopes: ["operator.write"],
          },
          internal: {
            allowModelOverride: true,
          },
        } as AgentHandlerArgs["client"],
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });

  // #5369: sessions.patch can write modelOverride to the session store between
  // when the agent handler reads its cached entry and when updateSessionStore
  // runs. The handler's loadSessionEntry may return the stale pre-patch entry
  // (no modelOverride), while the store-load inside updateSessionStore has the
  // fresh value. If the patch built from the stale entry carries modelOverride:
  // undefined, the merge {...fresh, ...patch} clobbers the fresh value.
  it("preserves fresh modelOverride when cached entry is stale (#5369)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // modelOverride absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-uuid",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-uuid": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          modelOverride: "qwen3-coder:30b",
          providerOverride: "ollama",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-uuid"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-uuid",
        idempotencyKey: "test-5369-race",
      },
      { reqId: "race-1" },
    );
    expect(capturedEntry?.modelOverride).toBe("qwen3-coder:30b");
    expect(capturedEntry?.providerOverride).toBe("ollama");
  });

  // Broader regression guard for the #5369 stale-writeback class: any field
  // that the patch blindly carries from the cached entry will clobber a fresh
  // concurrent write. The fix dropped all such fields from the patch; this
  // test ensures none get silently re-added. If a future change puts e.g.
  // `sendPolicy: entry?.sendPolicy` back into the patch, this test fails.
  it("preserves all fresh session fields when cached entry is stale (#5369 broader)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // All fields below absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-broader",
    });
    const freshFields = {
      sendPolicy: "allow",
      skillsSnapshot: { tools: ["bash"] },
      thinkingLevel: "high",
      fastMode: true,
      verboseLevel: "detailed",
      traceLevel: "info",
      reasoningLevel: "on",
      systemSent: true,
      spawnedWorkspaceDir: "/work/fresh",
      spawnDepth: 2,
      label: "fresh-label",
      spawnedBy: "agent:main:main",
      channel: "telegram",
      deliveryContext: {
        channel: "telegram",
        to: "12345",
        accountId: "acct-1",
        threadId: 42,
      },
      lastChannel: "telegram",
      lastTo: "12345",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      cliSessionIds: { "claude-cli": "fresh-cli-id" },
      cliSessionBindings: { "claude-cli": { sessionId: "fresh-binding" } },
      claudeCliSessionId: "fresh-cli-id",
    };
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-broader": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          ...freshFields,
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-broader"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-broader",
        idempotencyKey: "test-5369-broader",
      },
      { reqId: "broader-1" },
    );
    for (const [field, expected] of Object.entries(freshFields)) {
      expect(capturedEntry?.[field]).toEqual(expected);
    }
  });

  it("checks delivery sendPolicy against the fresh store entry (#5369)", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        // sendPolicy absent — stale pre-patch view
      },
      canonicalKey: "agent:main:subagent:test-policy",
    });
    const freshUpdatedAt = Date.now();
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-policy": {
          sessionId: "subagent-session-id",
          updatedAt: freshUpdatedAt,
          sendPolicy: "deny",
          channel: "telegram",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-policy"];
      return result;
    });
    mocks.resolveSendPolicy.mockImplementation((args?: { entry?: { sendPolicy?: string } }) =>
      args?.entry?.sendPolicy === "deny" ? "deny" : "allow",
    );
    mocks.agentCommand.mockClear();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-policy",
        channel: "telegram",
        to: "99999",
        deliver: true,
        idempotencyKey: "test-5369-policy",
      },
      { reqId: "policy-1", respond },
    );
    expectRespondError(respond, { message: "send blocked by session policy" });
    const sendPolicyArgs = expectRecordFields(mockCallArg(mocks.resolveSendPolicy), {
      sessionKey: "agent:main:subagent:test-policy",
    });
    expectRecordFields(sendPolicyArgs.entry, { sendPolicy: "deny" });
    expectRecordFields(capturedEntry, {
      sessionId: "subagent-session-id",
      updatedAt: freshUpdatedAt,
      sendPolicy: "deny",
      channel: "telegram",
      deliveryContext: undefined,
      lastTo: undefined,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("recovers terminal failed agent API sessions without rotating the session id", async () => {
    const sessionId = "failed-agent-session";
    await withTempDir({ prefix: "openclaw-gateway-terminal-recovery-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(`${sessionsDir}/${sessionId}.jsonl`, "", "utf8");
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: {
          sessionId,
          status: "failed",
          startedAt: 100,
          endedAt: 200,
          runtimeMs: 100,
          abortedLastRun: true,
          updatedAt: Date.now(),
        },
        canonicalKey: "agent:main:main",
      });

      const capturedEntry = await runMainAgentAndCaptureEntry("recover-terminal-agent-session");
      const call = await waitForAgentCommandCall();

      expect(call.sessionId).toBe(sessionId);
      expectRecordFields(capturedEntry, {
        sessionId,
        status: undefined,
        startedAt: undefined,
        endedAt: undefined,
        runtimeMs: undefined,
        abortedLastRun: undefined,
      });
    });
  });

  it("does not restore a stale session id over a fresh store rotation (#5369)", async () => {
    mocks.resolveSessionLifecycleTimestamps.mockImplementation(
      ({ entry }: { entry?: { sessionId?: string; sessionStartedAt?: number } }) => ({
        sessionStartedAt: entry?.sessionId === "old-session-id" ? 123 : entry?.sessionStartedAt,
        lastInteractionAt: undefined,
      }),
    );
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "old-session-id",
        updatedAt: Date.now() - 1000,
      },
      canonicalKey: "agent:main:subagent:test-rotation",
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-rotation": {
          sessionId: "fresh-session-id",
          updatedAt: Date.now(),
          status: "running",
          startedAt: 111,
          sessionFile: "/tmp/fresh-session.jsonl",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-rotation"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-rotation",
        idempotencyKey: "test-5369-rotation",
      },
      { reqId: "rotation-1" },
    );

    expectRecordFields(capturedEntry, {
      sessionId: "fresh-session-id",
      status: "running",
      startedAt: 111,
      sessionStartedAt: undefined,
    });
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  // Upgrade-path self-heal: a legacy session entry may lack sessionStartedAt
  // because the field was added after the entry was first persisted. The
  // handler recovers it from the transcript JSONL header and writes it back,
  // but only when the fresh store still lacks the field — so a concurrent
  // writer that sets it cannot be clobbered (the #5369 stale-writeback class).
  it("self-heals missing sessionStartedAt from JSONL when fresh store also lacks it", async () => {
    // Use a value distinct from `now` but recent enough that
    // evaluateSessionFreshness — which also calls the mocked
    // resolveSessionLifecycleTimestamps — keeps this session fresh.
    const recoveredStartedAt = Date.now() - 5_000;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "legacy-session-id",
        updatedAt: Date.now() - 1000,
        // sessionStartedAt absent — legacy schema
      },
      canonicalKey: "agent:main:subagent:legacy",
    });
    mocks.resolveSessionLifecycleTimestamps.mockReturnValue({
      sessionStartedAt: recoveredStartedAt,
      lastInteractionAt: undefined,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:legacy": {
          sessionId: "legacy-session-id",
          updatedAt: Date.now(),
          // sessionStartedAt absent on disk too — self-heal should fire
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:legacy"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:legacy",
        idempotencyKey: "test-selfheal-write",
      },
      { reqId: "selfheal-1" },
    );
    expect(capturedEntry?.sessionStartedAt).toBe(recoveredStartedAt);
  });

  it("does not clobber fresh sessionStartedAt with the recovered candidate", async () => {
    // See note in the prior test: keep both values recent so freshness
    // evaluation (which also reads the lifecycle mock) doesn't trip the
    // idle-reset path and turn this into an isNewSession path.
    const recoveredStartedAt = Date.now() - 5_000;
    const freshStartedAt = Date.now() - 2_500;
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "legacy-session-id",
        updatedAt: Date.now() - 1000,
        // sessionStartedAt absent in cached entry — would trigger recovery
      },
      canonicalKey: "agent:main:subagent:concurrent",
    });
    mocks.resolveSessionLifecycleTimestamps.mockReturnValue({
      sessionStartedAt: recoveredStartedAt,
      lastInteractionAt: undefined,
    });
    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:concurrent": {
          sessionId: "legacy-session-id",
          updatedAt: Date.now(),
          // Concurrent writer set sessionStartedAt between cache load and lock
          sessionStartedAt: freshStartedAt,
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:concurrent"];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:subagent:concurrent",
        idempotencyKey: "test-selfheal-noclobber",
      },
      { reqId: "selfheal-2" },
    );
    expect(capturedEntry?.sessionStartedAt).toBe(freshStartedAt);
  });

  it("reactivates completed subagent sessions and broadcasts send updates", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const updatedAt = Date.now() - 1_000;
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    };

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "sess-followup",
        updatedAt,
      },
      canonicalKey: childSessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt,
        },
      };
      return await updater(store);
    });
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(completedRun);
    mocks.replaceSubagentRunAfterSteer.mockReturnValueOnce(true);
    mocks.loadGatewaySessionRow.mockReturnValueOnce({
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "follow-up",
        sessionKey: childSessionKey,
        idempotencyKey: "run-new",
      },
      {
        respond,
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: vi.fn(), error: vi.fn() },
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          getRuntimeConfig: () => mocks.loadConfigReturn,
        } as unknown as GatewayRequestContext,
      },
    );

    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "run-new",
      status: "accepted",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId: "run-new" });
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock: mocks.replaceSubagentRunAfterSteer,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
      task: "follow-up",
    });
  });

  it("includes live session setting metadata in agent send events", async () => {
    const updatedAt = Date.now() - 1_000;
    mockMainSessionEntry({
      sessionId: "sess-main",
      updatedAt,
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          sessionId: "sess-main",
          updatedAt,
          fastMode: true,
          sendPolicy: "deny",
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        }),
      };
      return await updater(store);
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-live-settings",
      },
      {
        context: {
          dedupe: new Map(),
          addChatRun: vi.fn(),
          chatAbortControllers: new Map(),
          logGateway: { info: vi.fn(), error: vi.fn() },
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
          getRuntimeConfig: () => mocks.loadConfigReturn,
        } as unknown as GatewayRequestContext,
      },
    );

    expect(mockCallArg(broadcastToConnIds)).toBe("sessions.changed");
    expectRecordFields(mockCallArg(broadcastToConnIds, 0, 1), {
      sessionKey: "agent:main:main",
      reason: "send",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    });
    expect(mockCallArg(broadcastToConnIds, 0, 2)).toEqual(new Set(["conn-1"]));
    expect(mockCallArg(broadcastToConnIds, 0, 3)).toEqual({ dropIfSlow: true });
  });

  it("passes the raw user message to agentCommand for LLM-boundary timestamping", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      { reqId: "ts-1" },
    );

    const callArgs = await waitForAgentCommandCall<{ message?: string }>();
    expect(callArgs.message).toBe("Is it the weekend?");

    resetTimeConfig();
  });

  it("marks inter-session agent messages at the gateway boundary without timestamping them", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "forwarded reply",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-inter-session-marker",
      },
      { reqId: "inter-session-marker" },
    );

    const callArgs = await waitForAgentCommandCall<
      AgentCommandCall & {
        message?: string;
        userTurnTranscriptRecorder?: {
          message?: unknown;
        };
      }
    >();
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("isUser=false");
    expect(callArgs.message).toContain("forwarded reply");
    expect(callArgs.message).not.toContain("[Wed 2026-01-28 20:30 EST]");
    expect(callArgs.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "forwarded reply",
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:discord:source",
        sourceTool: "sessions_send",
      },
    });

    resetTimeConfig();
  });

  it("suppresses persisted prompts for subagent announce task-completion handoffs", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "runtime-only announce bookkeeping",
        agentId: "main",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceTool: "subagent_announce",
        },
        internalEvents: [
          {
            type: "task_completion",
            source: "subagent",
            childSessionKey: "agent:main:subagent:child",
            childSessionId: "child-session-id",
            announceType: "completion",
            taskLabel: "child task",
            status: "ok",
            statusLabel: "completed",
            result: "child result",
            statsLine: "tokens=10",
            replyInstruction: "Deliver the child result.",
          },
        ],
        idempotencyKey: "test-subagent-announce-suppress-prompt",
      },
      {
        reqId: "subagent-announce-suppress-prompt",
        client: backendGatewayClient(),
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      suppressPromptPersistence?: boolean;
      preserveUserFacingSessionModelState?: boolean;
      message?: string;
    }>();
    expect(callArgs.suppressPromptPersistence).toBe(true);
    expect(callArgs.preserveUserFacingSessionModelState).toBe(true);
    expect(callArgs.message).toMatch(/^\[Inter-session message\]/);
    expect(callArgs.message).toContain("sourceTool=subagent_announce");
  });

  it("restores exact cron continuation policy for generated-media wakes", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "claude-cli",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-claude-session" },
      },
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
        toolsAllow: ["image_generate", "write"],
        toolsAllowIsDefault: true,
        cliSessionBindingFacts: {
          sourceReplyDeliveryMode: "automatic" as const,
          requireExplicitMessageTarget: true,
        },
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "continued" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "image generation finished",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-continuation",
      },
      {
        reqId: "cron-media-continuation",
        client: cronContinuationGatewayClient(),
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      bootstrapContextRunKind?: string;
      provider?: string;
      model?: string;
      thinking?: string;
      sessionId?: string;
      toolsAllow?: string[];
      toolsAllowIsDefault?: boolean;
      requireExplicitMessageTarget?: boolean;
      sourceReplyDeliveryMode?: string;
      cliSessionBindingFacts?: {
        sourceReplyDeliveryMode?: string;
        requireExplicitMessageTarget?: boolean;
      };
      allowModelOverride?: boolean;
      senderIsOwner?: boolean;
    }>();
    expect(callArgs.sessionId).toBe("run-1");
    expect(callArgs.provider).toBe("claude-cli");
    expect(callArgs.model).toBe("claude-opus-4-8");
    expect(callArgs.thinking).toBe("high");
    expect(callArgs.bootstrapContextRunKind).toBe("cron");
    expect(callArgs.toolsAllow).toEqual(["image_generate", "write"]);
    expect(callArgs.toolsAllowIsDefault).toBe(true);
    expect(callArgs.requireExplicitMessageTarget).toBe(true);
    expect(callArgs.sourceReplyDeliveryMode).toBe("automatic");
    expect(callArgs.cliSessionBindingFacts).toEqual({
      sourceReplyDeliveryMode: "automatic",
      requireExplicitMessageTarget: true,
    });
    expect(callArgs.allowModelOverride).toBe(true);
    expect(callArgs.senderIsOwner).toBe(true);
  });

  it.each([
    {
      name: "from a public operator caller",
      client: "operator" as const,
      phase: "ready" as const,
      freshRevision: "revision-1",
      code: ErrorCodes.INVALID_REQUEST,
    },
    {
      name: "from a backend-mode caller without server authority",
      client: "backend" as const,
      phase: "ready" as const,
      freshRevision: "revision-1",
      code: ErrorCodes.INVALID_REQUEST,
    },
    {
      name: "before the initial cron owner is ready",
      client: "continuation" as const,
      phase: "running" as const,
      freshRevision: "revision-1",
      code: ErrorCodes.UNAVAILABLE,
    },
    {
      name: "after its lifecycle revision changes",
      client: "continuation" as const,
      phase: "ready" as const,
      freshRevision: "revision-2",
      code: ErrorCodes.UNAVAILABLE,
    },
    {
      name: "after the gateway owner generation is lost",
      client: "continuation" as const,
      phase: "continuing" as const,
      freshRevision: "revision-1",
      ownerLifecycleGeneration: "retired-gateway-generation",
      code: ErrorCodes.INVALID_REQUEST,
    },
    {
      name: "when its stable base was not persisted",
      client: "continuation" as const,
      phase: "ready" as const,
      freshRevision: "revision-1",
      basePersisted: false,
      code: ErrorCodes.INVALID_REQUEST,
    },
  ])("rejects a cron media continuation $name", async (testCase) => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: testCase.phase,
        basePersisted:
          "basePersisted" in testCase ? testCase.basePersisted : testCase.phase === "ready",
        ...("ownerLifecycleGeneration" in testCase
          ? { ownerLifecycleGeneration: testCase.ownerLifecycleGeneration }
          : {}),
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const freshEntry = structuredClone(entry);
    if (!freshEntry.cronRunContinuation) {
      throw new Error("expected cron continuation fixture");
    }
    freshEntry.cronRunContinuation.lifecycleRevision = testCase.freshRevision;
    const store: Record<string, SessionEntry> = { [sessionKey]: freshEntry };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));

    const respond = await invokeAgent(
      {
        message: "image generation finished",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: `cron-media-rejected-${testCase.phase}-${testCase.freshRevision}`,
      },
      {
        flushDispatch: false,
        client:
          testCase.client === "continuation"
            ? cronContinuationGatewayClient()
            : testCase.client === "backend"
              ? backendGatewayClient()
              : operatorWriteGatewayClient(),
      },
    );

    expectRespondError(respond, { code: testCase.code });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("claims an exact cron continuation until the admitted agent turn settles", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    let finishFirstTurn: (result: { payloads: Array<{ text: string }> }) => void = () => {};
    mocks.agentCommand.mockImplementationOnce(
      async () =>
        await new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
          finishFirstTurn = resolve;
        }),
    );
    const context = makeContext();
    const first = await invokeAgent(
      {
        message: "first media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-first",
      },
      {
        reqId: "cron-media-first",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAgentCommandCall();
    expect(
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
    ).toMatchObject({
      phase: "continuing",
      ownerRunId: "cron-media-first",
    });

    const second = await invokeAgent(
      {
        message: "second media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-second",
      },
      {
        reqId: "cron-media-second",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    expectRespondError(second, {
      code: ErrorCodes.UNAVAILABLE,
      message: "cron run continuation changed before admission",
    });
    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
    ).toMatchObject({
      phase: "continuing",
      ownerRunId: "cron-media-first",
    });

    finishFirstTurn({ payloads: [{ text: "continued" }] });
    await waitForAssertion(() => {
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toEqual({
        lifecycleRevision: "revision-1",
        phase: "ready",
        basePersisted: true,
      });
    });
    expect(first).toHaveBeenCalledWith(true, expect.objectContaining({ status: "ok" }), undefined, {
      runId: "cron-media-first",
    });
  });

  it("keeps an exact continuation ready for later media when the stable row was deleted", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:delete-after-run:run:run-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready",
        basePersisted: true,
      },
    };
    const store: Record<string, SessionEntry> = { [sessionKey]: structuredClone(entry) };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }] });

    for (const reqId of ["cron-media-first", "cron-media-second"]) {
      await invokeAgent(
        {
          message: `${reqId} finished`,
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: reqId,
        },
        { reqId, client: cronContinuationGatewayClient() },
      );
      await waitForAssertion(() => {
        expect(store[sessionKey]?.cronRunContinuation).toEqual({
          lifecycleRevision: "revision-1",
          phase: "ready",
          basePersisted: true,
        });
      });
    }
    expect(mocks.agentCommand).toHaveBeenCalledTimes(2);
  });

  it("persists a fallback model after the continuation session id rotates", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").sessionId = "run-2";
      const onActiveModelSelected = call.onActiveModelSelected;
      if (typeof onActiveModelSelected !== "function") {
        throw new Error("expected active model callback");
      }
      await onActiveModelSelected({ provider: "anthropic", model: "claude-sonnet-4-6" });
      return { payloads: [{ text: "continued" }] };
    });

    await invokeAgent(
      {
        message: "media completion after compaction",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-rotated",
      },
      {
        reqId: "cron-media-rotated",
        client: cronContinuationGatewayClient(),
      },
    );

    await waitForAssertion(() => {
      expect(store[sessionKey]).toMatchObject({
        sessionId: "run-2",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        cronRunContinuation: {
          lifecycleRevision: "revision-1",
          phase: "ready",
        },
      });
      expect(store[baseSessionKey]).toMatchObject({
        sessionId: "run-2",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });
  });

  it("does not promote a failed continuation candidate without committed media", async () => {
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:cron:job-1:run:run-1";
    const baseSessionKey = "agent:main:cron:job-1";
    const entry: SessionEntry = {
      sessionId: "run-1",
      updatedAt: Date.now(),
      lifecycleRevision: "revision-1",
      modelProvider: "openai",
      model: "gpt-5.4",
      contextTokens: 128_000,
      agentHarnessId: "openclaw",
      cliSessionBindings: { "openai-cli": { sessionId: "native-a" } },
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "ready" as const,
        basePersisted: true,
      },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry,
    });
    const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = structuredClone(entry);
    const store: Record<string, SessionEntry> = {
      [baseSessionKey]: baseEntry,
      [sessionKey]: structuredClone(entry),
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      const onActiveModelSelected = call.onActiveModelSelected;
      if (typeof onActiveModelSelected !== "function") {
        throw new Error("expected continuation model callback");
      }
      await onActiveModelSelected({ provider: "gemini-cli", model: "gemini-3" });
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").contextTokens =
        1_000_000;
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").contextBudgetStatus = {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 2,
        provider: "gemini-cli",
        model: "gemini-3",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 10,
        contextTokenBudget: 1_000_000,
        promptBudgetBeforeReserve: 900_000,
        reserveTokens: 100_000,
        effectiveReserveTokens: 100_000,
        remainingPromptBudgetTokens: 900_000,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 1,
        unwindowedMessageCount: 1,
      };
      expectDefined(store[sessionKey], "store[sessionKey] test invariant").agentHarnessId =
        "gemini";
      return { payloads: [], meta: { error: "candidate failed", stopReason: "error" } };
    });

    await invokeAgent(
      {
        message: "media continuation candidate fails",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-failed-candidate",
      },
      { reqId: "cron-media-failed-candidate", client: cronContinuationGatewayClient() },
    );

    for (const persisted of [store[sessionKey], store[baseSessionKey]]) {
      expect(persisted).toMatchObject({
        modelProvider: "openai",
        model: "gpt-5.4",
        contextTokens: 128_000,
        agentHarnessId: "openclaw",
        cliSessionBindings: { "openai-cli": { sessionId: "native-a" } },
      });
      expect(
        expectDefined(persisted, "persisted test invariant").cliSessionBindings?.["gemini-cli"],
      ).toBeUndefined();
      expect(
        expectDefined(persisted, "persisted test invariant").contextBudgetStatus,
      ).toBeUndefined();
    }
  });

  it("recovers a continuation release after reporting a durable write failure", async () => {
    vi.useFakeTimers();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    try {
      mocks.agentCommand.mockClear();
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          if (releaseAttempts <= 3) {
            throw new Error("disk unavailable");
          }
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });
      const request = {
        message: "media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-release-fails",
      };

      const respond = await invokeAgent(request, {
        reqId: "cron-media-release-fails",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(releaseAttempts).toBe(3);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toMatchObject({
        phase: "continuing",
        ownerRunId: "cron-media-release-fails",
      });
      expect(respond).toHaveBeenLastCalledWith(
        false,
        expect.objectContaining({
          status: "error",
          summary: "failed to persist cron continuation settlement",
        }),
        expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
        expect.objectContaining({ runId: "cron-media-release-fails" }),
      );
      const busyPrepare = await invokeGatewaySuspendPrepare(context, "cron-media-release-backoff");
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          reason: "active-work",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      await vi.advanceTimersByTimeAsync(250);

      expect(releaseAttempts).toBe(4);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toEqual({
        lifecycleRevision: "revision-1",
        phase: "ready",
        basePersisted: true,
      });
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-recovered",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
      const retryRespond = await invokeAgent(request, {
        reqId: "cron-media-release-retry",
        client: cronContinuationGatewayClient(),
        context,
      });
      expect(retryRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "ok", summary: "completed" }),
        undefined,
        { cached: true },
      );
      expect(mocks.agentCommand).toHaveBeenCalledOnce();
    } finally {
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it("releases suspension admission after continuation recovery exhausts", async () => {
    vi.useFakeTimers();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    try {
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          throw new Error("disk unavailable");
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });

      await invokeAgent(
        {
          message: "media completion",
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: "cron-media-release-exhausts",
        },
        {
          reqId: "cron-media-release-exhausts",
          client: cronContinuationGatewayClient(),
          context,
          flushDispatch: false,
        },
      );
      await vi.advanceTimersByTimeAsync(10);

      expect(releaseAttempts).toBe(3);
      const busyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-exhaustion-backoff",
      );
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      for (const delayMs of [250, 1_000, 4_000, 15_000]) {
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      expect(releaseAttempts).toBe(15);
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        "cron continuation release recovery exhausted for cron-media-release-exhausts",
      );
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-exhausted",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
    } finally {
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });
});
