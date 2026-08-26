import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../../process/gateway-work-admission.test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createBoardHarness as createHarness } from "./board.test-support.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const reviewWidgetApproval = vi.hoisted(() => vi.fn());

vi.mock("../../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: vi.fn(() => reviewWidgetApproval),
}));
vi.mock("./sessions.runtime.js", () => ({
  performGatewaySessionReset: vi.fn(async ({ key, reason }: { key: string; reason: string }) => ({
    ok: true,
    key,
    agentId: "main",
    entry: { sessionId: `reset-${reason}` },
    resolved: {},
  })),
}));

describe("board gateway runtime boundaries", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
    reviewWidgetApproval.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("enforces data bindings against the granted tool set", async () => {
    const readDataBinding = vi.fn(async () => ({ sessions: ["one"] }));
    const { invoke, store } = createHarness(undefined, { readDataBinding });
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "reader",
      content: { kind: "html", html: "reader" },
    });
    let board = await invoke("board.get", { sessionKey: "session" });
    let snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const denied = await invoke("board.data.read", {
      ticket: snapshot.widgets[0]?.viewTicket,
      bindingId: "sessions.list",
      params: { limit: 2 },
    });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(readDataBinding).not.toHaveBeenCalled();

    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "reader",
      content: { kind: "html", html: "reader" },
      declared: { tools: ["sessions.list"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "reader",
      decision: "granted",
      revision: 2,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    board = await invoke("board.get", { sessionKey: "session" });
    snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const allowed = await invoke("board.data.read", {
      ticket: snapshot.widgets[0]?.viewTicket,
      bindingId: "sessions.list",
      params: { limit: 2 },
    });
    expect(allowed.mock.calls[0]?.[1]).toEqual({ sessions: ["one"] });
    expect(readDataBinding).toHaveBeenCalledWith(
      "sessions.list",
      { limit: 2 },
      expect.objectContaining({ params: expect.any(Object) }),
    );
  });

  it.each([
    {
      name: "layout update before applyOps",
      run: async () => {
        const harness = createHarness();
        const response = await runWithGatewayRootWorkAdmissionForTest(async () => {
          resetGatewayWorkAdmission();
          return await harness.invoke("board.update", {
            sessionKey: "session",
            ops: [{ kind: "tab_create", tabId: "ops", title: "Ops" }],
          });
        });
        return {
          response,
          verify: () => expect(harness.store.getSnapshot("session").tabs).toEqual([]),
        };
      },
    },
    {
      name: "Canvas widget after document materialization",
      run: async () => {
        const harness = createHarness(async () => {
          resetGatewayWorkAdmission();
          return { html: "<p>canvas</p>", cspSandbox: "scripts" };
        });
        const response = await runWithGatewayRootWorkAdmissionForTest(() =>
          harness.invoke("board.widget.put", {
            sessionKey: "session",
            name: "canvas",
            content: { kind: "canvas-doc", docId: "canvas-doc" },
          }),
        );
        return {
          response,
          verify: () => expect(harness.store.getSnapshot("session").widgets).toEqual([]),
        };
      },
    },
    {
      name: "automatic widget approval before grant",
      run: async () => {
        const pluginRegistry = createEmptyPluginRegistry();
        markPluginRegistryActive(pluginRegistry);
        reviewWidgetApproval.mockImplementationOnce(async () => {
          markPluginRegistryRetired(pluginRegistry);
          markPluginRegistryActive(pluginRegistry);
          return {
            decision: "allow-once",
            risk: "low",
            rationale: "approved before plugin reload",
          };
        });
        const harness = createHarness(undefined, undefined, undefined, {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: "main" }] },
            tools: { exec: { mode: "auto" } },
          }),
        });
        const response = await withPluginRuntimeGatewayRequestScope(
          { isWebchatConnect: () => false, pluginRegistry },
          () =>
            runWithGatewayRootWorkAdmissionForTest(() =>
              harness.invoke("board.widget.put", {
                sessionKey: "session",
                name: "approval",
                content: { kind: "html", html: "approval" },
                declared: { netOrigins: ["https://example.com"] },
              }),
            ),
        );
        return {
          response,
          verify: () =>
            expect(harness.store.getSnapshot("session").widgets).toMatchObject([
              { name: "approval", grantState: "pending" },
            ]),
        };
      },
    },
    {
      name: "explicit widget grant before store grant",
      run: async () => {
        const harness = createHarness();
        const put = await harness.invoke("board.widget.put", {
          sessionKey: "session",
          name: "grant",
          content: { kind: "html", html: "grant" },
          declared: { netOrigins: ["https://example.com"] },
        });
        const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot | undefined;
        const widget = snapshot?.widgets[0];
        if (!widget) {
          throw new Error("board.widget.put did not return a widget");
        }
        harness.broadcast.mockClear();
        const response = await runWithGatewayRootWorkAdmissionForTest(async () => {
          resetGatewayWorkAdmission();
          return await harness.invoke("board.widget.grant", {
            sessionKey: "session",
            name: widget.name,
            decision: "granted",
            revision: widget.revision,
            instanceId: widget.instanceId,
          });
        });
        return {
          response,
          verify: () =>
            expect(harness.store.getSnapshot("session").widgets).toMatchObject([
              { name: "grant", grantState: "pending" },
            ]),
        };
      },
    },
    {
      name: "widget event before notice append",
      run: async () => {
        const harness = createHarness();
        await harness.invoke("board.widget.put", {
          sessionKey: "session",
          name: "counter",
          content: { kind: "html", html: "counter" },
        });
        harness.broadcast.mockClear();
        const response = await runWithGatewayRootWorkAdmissionForTest(async () => {
          resetGatewayWorkAdmission();
          return await harness.invoke("board.event", {
            sessionKey: "session",
            widget: "counter",
            payload: { count: 1 },
          });
        });
        return {
          response,
          verify: () => expect(peekSystemEvents("agent:main:session")).toEqual([]),
        };
      },
    },
  ])("fences $name to its request and plugin authority", async ({ run }) => {
    const { response, verify } = await run();

    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    verify();
  });

  it("rejects unknown data bindings inside the gateway allowlist boundary", async () => {
    const { invoke, store } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "reader",
      content: { kind: "html", html: "reader" },
      declared: { tools: ["secrets.dump"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "reader",
      decision: "granted",
      revision: 1,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const response = await invoke("board.data.read", {
      ticket: snapshot.widgets[0]?.viewTicket,
      bindingId: "secrets.dump",
    });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not allowed") }),
    );
  });

  it("runs only the exact granted cron job capability", async () => {
    const triggerCronJob = vi.fn(async (jobId: string) => ({ ok: true, jobId }));
    const { invoke, store } = createHarness(undefined, { triggerCronJob });
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "runner",
      content: { kind: "html", html: "runner" },
      declared: { tools: ["cron.trigger:job-1"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "runner",
      decision: "granted",
      revision: 1,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const ticket = snapshot.widgets[0]?.viewTicket;

    const denied = await invoke("board.action", {
      ticket,
      action: "cron.trigger",
      jobId: "job-2",
    });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(triggerCronJob).not.toHaveBeenCalled();

    const allowed = await invoke("board.action", {
      ticket,
      action: "cron.trigger",
      jobId: "job-1",
    });
    expect(allowed.mock.calls[0]?.[1]).toEqual({ ok: true, jobId: "job-1" });
    expect(triggerCronJob).toHaveBeenCalledWith("job-1", expect.any(Object));
  });

  it("caps board.event payloads and preserves Unicode at the notice boundary", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const clippedCodeUnits = 500 - "[dashboard] ".length - " on widget counter".length - 1;
    // JSON's opening quote places the emoji across the legacy slice boundary.
    const payload = `${"x".repeat(clippedCodeUnits - 2)}😀tail`;
    await invoke("board.event", { sessionKey: "session", widget: "counter", payload });
    const unicodeNotice = peekSystemEvents("agent:main:session")[0] ?? "";
    expect(unicodeNotice.length).toBeLessThanOrEqual(500);
    expect(unicodeNotice).not.toContain(String.fromCharCode(0xd83d));
    expect(unicodeNotice).toMatch(/… on widget counter$/u);
    await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(1_000),
    });
    expect(peekSystemEvents("agent:main:session")[1]).toHaveLength(500);
    const oversized = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(8_193),
    });
    expect(oversized.mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps board state across the real sessions.reset handler", async () => {
    const sessionKey = "agent:main:board-reset-proof";
    const stateDir = tempDirs.make("openclaw-board-reset-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath: database.path },
      { sessionId: "board-reset-proof", updatedAt: Date.now() },
    );
    const boardStore = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    boardStore.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });
    const respond = vi.fn<RespondFn>();
    await sessionMutationHandlers["sessions.reset"]!({
      req: { type: "req", id: "reset", method: "sessions.reset", params: {} },
      params: { key: sessionKey, reason: "reset" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        broadcast: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(boardStore.getSnapshot(sessionKey).widgets).toHaveLength(1);
  });
});
