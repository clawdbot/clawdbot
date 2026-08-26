// Cron tool tests cover schedule guidance, scoped job operations, delivery
// context inheritance, session routing, and agent id ownership.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock, extractDeliveryInfoMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  return {
    ...actual,
    resolveSessionAgentId: actual.resolveSessionAgentId,
  };
});

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  consumeCronCreatorAuthorityGrant,
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
  type CronCreatorAuthorityGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityResolver,
} from "../cron-creator-authority-context.js";
import { createCronTool } from "./cron-tool.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

describe("cron tool", () => {
  function runWithTestCronCreatorAuthority<T>(
    runId: string,
    run: () => T,
    signal?: AbortSignal,
  ): T {
    const capability = createCronCreatorAuthorityCapability(runId);
    if (!capability) {
      throw new Error("expected cron creator authority capability");
    }
    return runWithCronCreatorAuthorityCapability(capability, run, signal);
  }

  type SchemaLike = {
    anyOf?: Array<SchemaLike>;
    description?: string;
    properties?: Record<string, SchemaLike>;
    type?: string;
  };

  type TestDelivery = {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };

  function createTestCronTool(
    opts?: Parameters<typeof createCronTool>[0],
  ): ReturnType<typeof createCronTool> {
    return createCronTool(opts, {
      callGatewayTool: async (method, gatewayOpts, params) => {
        const result = await callGatewayMock({ method, params }, gatewayOpts);
        if (
          method === "cron.get" &&
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          Object.hasOwn(result, "payload") &&
          !Object.hasOwn(result, "configRevision")
        ) {
          return { ...result, configRevision: "sha256:test" };
        }
        return result;
      },
    });
  }

  function resolvedCreatorAuthority(
    tools: readonly (string | { name: string; pluginId?: string })[],
    grant: CronCreatorAuthorityGrant = { runId: "run-test", token: "grant-test" },
  ) {
    return {
      tools,
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
      grant,
    };
  }

  function readGatewayCall(index = 0): { method?: string; params?: Record<string, unknown> } {
    return (
      (callGatewayMock.mock.calls[index]?.[0] as
        | { method?: string; params?: Record<string, unknown> }
        | undefined) ?? { method: undefined, params: undefined }
    );
  }

  function readGatewayOpts(index = 0): Record<string, unknown> | undefined {
    return callGatewayMock.mock.calls[index]?.[1] as Record<string, unknown> | undefined;
  }

  function readCronPayloadText(index = 0): string {
    const params = readGatewayCall(index).params as { payload?: { text?: string } } | undefined;
    return params?.payload?.text ?? "";
  }

  function expectSingleGatewayCallMethod(method: string) {
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = readGatewayCall(0);
    expect(call.method).toBe(method);
    return call.params;
  }

  it("tells models to keep cron expressions in local wall-clock time for tz", () => {
    const tool = createTestCronTool();

    expect(tool.description).toContain("expr is wall time in tz");
    expect(tool.description).toContain("never pre-convert to UTC");
    expect(tool.description).toContain("no tz=gateway host local");
    expect(tool.description).toContain("no tz=UTC");
    expect(tool.description).toContain('expr:"0 18 * * *"');
    expect(tool.description).toContain('tz:"Asia/Shanghai"');
  });

  it("supports the promotion creation path: enabled add inherits conversation delivery, then a forced test run", async () => {
    // Promotion flow contract (the guidance itself lives in the system prompt,
    // since the repeat is noticed during ordinary work rather than while
    // reading this tool's schema). The job is created enabled so the
    // scheduler's failure alerts and auto-disable own a broken job; a job left
    // disabled pending confirmation is watched by nothing. Delivery is
    // inherited from the requesting conversation and the forced run is the
    // visible test.
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      currentDeliveryContext: {
        channel: "matrix",
        to: "room:!AbCdEf1234567890:example.org",
        threadId: "$RootEvent:Example.Org",
      },
    });
    callGatewayMock.mockResolvedValueOnce({ id: "job-promoted" });
    await tool.execute("call-promote-add", {
      action: "add",
      job: {
        name: "morning brief",
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Vienna" },
        payload: { kind: "agentTurn", message: "Summarize overnight updates." },
      },
    });
    const addCall = readGatewayCall(0);
    expect(addCall.method).toBe("cron.add");
    // Never created disabled: that is the one state no scheduler guard watches.
    expect(addCall.params?.enabled).not.toBe(false);
    expect(addCall.params?.delivery).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "room:!AbCdEf1234567890:example.org",
      threadId: "$RootEvent:Example.Org",
    });

    await tool.execute("call-promote-test-run", {
      action: "run",
      jobId: "job-promoted",
      runMode: "force",
    });
    const runCall = readGatewayCall(1);
    expect(runCall.method).toBe("cron.run");
    expect(runCall.params).toEqual({ id: "job-promoted", mode: "force" });

    // Failed test is cleaned up, not left behind as a broken schedule.
    await tool.execute("call-promote-rollback", {
      action: "remove",
      jobId: "job-promoted",
    });
    const removeCall = readGatewayCall(2);
    expect(removeCall.method).toBe("cron.remove");
    expect(removeCall.params).toEqual({ id: "job-promoted" });
  });

  function buildReminderAgentTurnJob(overrides: Record<string, unknown> = {}): {
    name: string;
    schedule: { at: string };
    payload: { kind: "agentTurn"; message: string };
    delivery?: { mode: string; to?: string };
  } {
    return {
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      payload: { kind: "agentTurn", message: "hello" },
      ...overrides,
    };
  }

  async function executeAddAndReadDelivery(params: {
    callId: string;
    agentSessionKey?: string;
    currentDeliveryContext?: NonNullable<
      Parameters<typeof createCronTool>[0]
    >["currentDeliveryContext"];
    delivery?: TestDelivery | null;
  }) {
    const tool = createTestCronTool({
      agentSessionKey: params.agentSessionKey,
      currentDeliveryContext: params.currentDeliveryContext,
    });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      },
    });

    return (readGatewayCall().params as { delivery?: TestDelivery } | undefined)?.delivery;
  }

  async function executeAddAndReadSessionKey(params: {
    callId: string;
    agentSessionKey: string;
    jobSessionKey?: string;
  }): Promise<string | undefined> {
    const tool = createTestCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        ...(params.jobSessionKey ? { sessionKey: params.jobSessionKey } : {}),
        payload: { kind: "systemEvent", text: "hello" },
      },
    });
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string } | undefined;
    return payload?.sessionKey;
  }

  async function executeAddAndReadAgentId(params: {
    callId: string;
    agentSessionKey: string;
    agentId?: unknown;
    includeAgentId?: boolean;
  }): Promise<unknown> {
    const tool = createTestCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        ...(params.includeAgentId ? { agentId: params.agentId } : {}),
      },
    });
    return readGatewayCall().params?.agentId;
  }

  async function executeAddWithContextMessages(callId: string, contextMessages: number) {
    const tool = createTestCronTool({ agentSessionKey: "main" });
    await tool.execute(callId, {
      action: "add",
      contextMessages,
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });
  }

  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  });

  it("allows scoped isolated cron runs to remove the current job", async () => {
    // Self-removal scope lets a cron-triggered run clean up its own schedule
    // without granting broad cron mutation access.
    const tool = createTestCronTool({
      agentSessionKey: "main",
      selfRemoveOnlyJobId: "job-current",
    });

    await tool.execute("call-self-remove", {
      action: "remove",
      jobId: "job-current",
    });

    const params = expectSingleGatewayCallMethod("cron.remove");
    expect(params).toEqual({ id: "job-current" });
  });

  it("denies scoped isolated cron runs from removing another job", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "main",
      selfRemoveOnlyJobId: "job-current",
    });

    await expect(
      tool.execute("call-remove-other", {
        action: "remove",
        jobId: "job-other",
      }),
    ).rejects.toThrow("Automations tool is restricted to the current automation.");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows scoped isolated cron runs to read the current job run history", async () => {
    callGatewayMock.mockResolvedValueOnce({
      entries: [{ jobId: "job-current", status: "ok" }],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    });
    const tool = createTestCronTool({
      agentSessionKey: "main",
      selfRemoveOnlyJobId: "job-current",
    });

    const result = await tool.execute("call-self-runs", {
      action: "runs",
      jobId: "job-current",
    });

    const params = expectSingleGatewayCallMethod("cron.runs");
    expect(params).toEqual({ id: "job-current" });
    expect(result.details).toEqual({
      entries: [{ jobId: "job-current", status: "ok" }],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    });
  });

  it.each([
    ["another job", { action: "runs", jobId: "job-other" }],
    ["missing job id", { action: "runs" }],
  ])("denies scoped isolated cron runs from reading %s run history", async (_label, args) => {
    const tool = createTestCronTool({
      agentSessionKey: "main",
      selfRemoveOnlyJobId: "job-current",
    });

    await expect(tool.execute("call-runs-denied", args)).rejects.toThrow(
      "Automations tool is restricted to the current automation.",
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows scoped isolated cron runs to read cron scheduler status", async () => {
    callGatewayMock.mockResolvedValueOnce({
      enabled: true,
      storePath: "/home/user/.openclaw/cron/jobs.json",
      jobs: 37,
      nextWakeAtMs: 1_234,
    });
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    const result = await tool.execute("call-status", {
      action: "status",
      timeoutMs: 10_000,
    });

    const params = expectSingleGatewayCallMethod("cron.status");
    expect(params).toStrictEqual({});
    expect(result.details).toEqual({ enabled: true });
  });

  it("passes parsed string timeoutMs values through to gateway calls", async () => {
    callGatewayMock.mockResolvedValueOnce({ enabled: true });
    const tool = createTestCronTool();

    await tool.execute("call-status-timeout", {
      action: "status",
      timeoutMs: "5000",
    });

    expectSingleGatewayCallMethod("cron.status");
    expect(readGatewayOpts(0)?.timeoutMs).toBe(5000);
  });

  it("allows scoped isolated cron runs to get the current job", async () => {
    callGatewayMock.mockResolvedValueOnce({ id: "job-current", name: "current" });
    const tool = createTestCronTool({
      agentSessionKey: "main",
      selfRemoveOnlyJobId: "job-current",
    });

    const result = await tool.execute("call-get", {
      action: "get",
      jobId: "job-current",
    });

    const params = expectSingleGatewayCallMethod("cron.get");
    expect(params).toStrictEqual({ id: "job-current" });
    expect(result.details).toEqual({ id: "job-current", name: "current" });
  });

  it.each([
    ["another job", { action: "get", jobId: "job-other" }],
    ["missing job id", { action: "get" }],
  ])("denies scoped isolated cron runs from getting %s", async (_label, args) => {
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    await expect(tool.execute("call-get-denied", args)).rejects.toThrow(
      "Automations tool is restricted to the current automation.",
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows scoped isolated cron runs to list only the current job", async () => {
    callGatewayMock.mockResolvedValueOnce({
      jobs: [
        { id: "job-current", name: "current" },
        { id: "job-other", name: "other" },
      ],
      snapshotRevision: "self-list-one-page",
      total: 2,
      offset: 0,
      limit: 2,
      hasMore: false,
      nextOffset: null,
      deliveryPreviews: {
        "job-current": { label: "current", detail: "self" },
        "job-other": { label: "other", detail: "hidden" },
      },
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:cron:job-current:run:abc",
      selfRemoveOnlyJobId: "job-current",
    });

    const result = await tool.execute("call-list", {
      action: "list",
      includeDisabled: true,
    });

    const params = expectSingleGatewayCallMethod("cron.list");
    expect(params).toEqual({
      includeDisabled: true,
      compact: true,
      agentId: "agent-123",
      limit: 200,
      offset: 0,
    });
    expect(result.details).toEqual({
      jobs: [{ id: "job-current", name: "current" }],
      total: 1,
      offset: 0,
      limit: 1,
      hasMore: false,
      nextOffset: null,
      deliveryPreviews: {
        "job-current": { label: "current", detail: "self" },
      },
    });
  });

  it("pages scoped isolated cron list until it finds the current job", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        jobs: Array.from({ length: 200 }, (_, index) => ({
          id: `job-old-${index}`,
          name: `old ${index}`,
        })),
        snapshotRevision: "self-list-paged",
        total: 201,
        offset: 0,
        limit: 200,
        hasMore: true,
        nextOffset: 200,
        deliveryPreviews: {},
      })
      .mockResolvedValueOnce({
        jobs: [{ id: "job-current", name: "current" }],
        snapshotRevision: "self-list-paged",
        total: 201,
        offset: 200,
        limit: 200,
        hasMore: false,
        nextOffset: null,
        deliveryPreviews: {
          "job-current": { label: "current", detail: "self" },
        },
      });
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:cron:job-current:run:abc",
      selfRemoveOnlyJobId: "job-current",
    });

    const result = await tool.execute("call-list-paged", {
      action: "list",
      includeDisabled: true,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(readGatewayCall(0)).toEqual({
      method: "cron.list",
      params: {
        includeDisabled: true,
        compact: true,
        agentId: "agent-123",
        limit: 200,
        offset: 0,
      },
    });
    expect(readGatewayCall(1)).toEqual({
      method: "cron.list",
      params: {
        includeDisabled: true,
        compact: true,
        agentId: "agent-123",
        limit: 200,
        offset: 200,
      },
    });
    expect(result.details).toEqual({
      jobs: [{ id: "job-current", name: "current" }],
      total: 1,
      offset: 0,
      limit: 1,
      hasMore: false,
      nextOffset: null,
      deliveryPreviews: {
        "job-current": { label: "current", detail: "self" },
      },
    });
  });

  it("restarts the scoped list when the current job moves behind the page boundary", async () => {
    const stableJobs = Array.from({ length: 199 }, (_, index) => ({
      id: `stable-${index}`,
      name: `stable ${index}`,
    }));
    callGatewayMock
      .mockResolvedValueOnce({
        jobs: [{ id: "stale-only", name: "stale" }, ...stableJobs],
        snapshotRevision: "revision-a",
        total: 201,
        offset: 0,
        limit: 200,
        hasMore: true,
        nextOffset: 200,
      })
      .mockResolvedValueOnce({
        jobs: [],
        snapshotRevision: "revision-b",
        total: 200,
        offset: 200,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      })
      .mockResolvedValueOnce({
        jobs: [...stableJobs, { id: "job-current", name: "current" }],
        snapshotRevision: "revision-b",
        total: 200,
        offset: 0,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      });
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    const result = await tool.execute("call-list-boundary-churn", { action: "list" });

    expect(callGatewayMock.mock.calls.map((call) => call[0].params.offset)).toEqual([0, 200, 0]);
    expect(result.details).toEqual({
      jobs: [{ id: "job-current", name: "current" }],
      total: 1,
      offset: 0,
      limit: 1,
      hasMore: false,
      nextOffset: null,
    });
  });

  it("rejects a scoped list after repeated snapshot churn", async () => {
    callGatewayMock.mockImplementation(async ({ params }: { params: Record<string, unknown> }) => {
      const callNumber = callGatewayMock.mock.calls.length;
      const offset = params.offset as number;
      if (offset === 0) {
        return {
          jobs: Array.from({ length: 200 }, (_, index) => ({ id: `job-${callNumber}-${index}` })),
          snapshotRevision: `revision-${callNumber}-a`,
          total: 201,
          offset: 0,
          limit: 200,
          hasMore: true,
          nextOffset: 200,
        };
      }
      return {
        jobs: [],
        snapshotRevision: `revision-${callNumber}-b`,
        total: 200,
        offset: 200,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      };
    });
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    await expect(tool.execute("call-list-churn", { action: "list" })).rejects.toThrow(
      "cron.list inventory changed repeatedly while reading current automation",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(8);
  });

  it("does not let requested pagination bypass the scoped current-job scan", async () => {
    callGatewayMock.mockResolvedValueOnce({
      jobs: [{ id: "job-current", name: "current" }],
      snapshotRevision: "self-list-requested-pagination",
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:cron:job-current:run:abc",
      selfRemoveOnlyJobId: "job-current",
    });

    const result = await tool.execute("call-scoped-list-requested-pagination", {
      action: "list",
      limit: 1,
      offset: 200,
    });

    expectSingleGatewayCallMethod("cron.list");
    expect(readGatewayCall().params).toEqual({
      includeDisabled: false,
      compact: true,
      agentId: "agent-123",
      limit: 200,
      offset: 0,
    });
    expect(result.details).toMatchObject({
      jobs: [{ id: "job-current", name: "current" }],
      total: 1,
      hasMore: false,
    });
  });

  it.each([
    ["add", { action: "add", job: buildReminderAgentTurnJob() }],
    ["update", { action: "update", jobId: "job-current", job: { enabled: false } }],
    ["run", { action: "run", jobId: "job-current" }],
    ["wake", { action: "wake", text: "wake up" }],
  ])("denies scoped isolated cron runs from using %s", async (_action, args) => {
    const tool = createTestCronTool({ selfRemoveOnlyJobId: "job-current" });

    await expect(tool.execute("call-denied", args)).rejects.toThrow(
      "Automations tool is restricted to the current automation.",
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("filters cron list by the requester agent session", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await tool.execute("call-list", {
      action: "list",
    });

    const params = expectSingleGatewayCallMethod("cron.list");
    expect(params).toEqual({
      includeDisabled: false,
      compact: true,
      agentId: "agent-123",
    });
  });

  it("rejects explicit cron list agent id outside the requester session", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await expect(
      tool.execute("call-list-explicit", {
        action: "list",
        agentId: "ops",
        includeDisabled: true,
      }),
    ).rejects.toThrow("cron list agentId must match the calling agent");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("preserves explicit agentId for sessionless cron list callers", async () => {
    const tool = createTestCronTool();

    await tool.execute("call-sessionless-list", {
      action: "list",
      agentId: "worker",
      includeDisabled: true,
    });

    const params = expectSingleGatewayCallMethod("cron.list");
    expect(params).toEqual({
      includeDisabled: true,
      compact: true,
      agentId: "worker",
    });
  });

  it("loads cron jobs beyond the first bounded page", async () => {
    const firstPage = {
      jobs: Array.from({ length: 200 }, (_, index) => ({
        id: `job-${index}`,
        name: `job ${index}`,
      })),
      total: 201,
      offset: 0,
      limit: 200,
      hasMore: true,
      nextOffset: 200,
    };
    const secondPage = {
      jobs: [{ id: "job-200", name: "job 200" }],
      total: 201,
      offset: 200,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    };
    callGatewayMock.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    const firstResult = await tool.execute("call-list-first-page", {
      action: "list",
      limit: 200,
      offset: 0,
    });
    const secondResult = await tool.execute("call-list-second-page", {
      action: "list",
      limit: 200,
      offset: firstPage.nextOffset,
    });

    expect(readGatewayCall(0)).toEqual({
      method: "cron.list",
      params: {
        includeDisabled: false,
        compact: true,
        agentId: "agent-123",
        limit: 200,
        offset: 0,
      },
    });
    expect(readGatewayCall(1)).toEqual({
      method: "cron.list",
      params: {
        includeDisabled: false,
        compact: true,
        agentId: "agent-123",
        limit: 200,
        offset: 200,
      },
    });
    expect(firstResult.details).toEqual(firstPage);
    expect(secondResult.details).toEqual(secondPage);
  });

  it.each([
    ["zero limit", { limit: 0 }],
    ["negative limit", { limit: -1 }],
    ["fractional limit", { limit: 1.5 }],
    ["oversized limit", { limit: 201 }],
    ["unsafe limit", { limit: Number.MAX_SAFE_INTEGER + 1 }],
    ["malformed limit", { limit: "1x" }],
    ["negative offset", { offset: -1 }],
    ["fractional offset", { offset: 1.5 }],
    ["unsafe offset", { offset: Number.MAX_SAFE_INTEGER + 1 }],
    ["malformed offset", { offset: "1x" }],
  ])("rejects a %s before calling the cron gateway", async (_label, pagination) => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-invalid-list-pagination", { action: "list", ...pagination }),
    ).rejects.toThrow(/(?:limit|offset) must be a (?:positive|non-negative) integer/);

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("retries cron.list without compact for older gateways", async () => {
    callGatewayMock
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid cron.list params: at root: unexpected property 'compact'",
        }),
      )
      .mockResolvedValueOnce({ jobs: [] });
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await tool.execute("call-list-older-gateway", { action: "list" });

    expect(readGatewayCall(0)).toEqual({
      method: "cron.list",
      params: {
        includeDisabled: false,
        compact: true,
        agentId: "agent-123",
      },
    });
    expect(readGatewayCall(1)).toEqual({
      method: "cron.list",
      params: {
        includeDisabled: false,
        agentId: "agent-123",
      },
    });
  });

  describe("wake routing", () => {
    // Pin the agentId / sessionKey resolution contract for `action: "wake"`.
    // The gateway target resolver treats `agentId` as authoritative, so
    // pairing the caller's inferred agentId with a foreign explicit
    // sessionKey would canonicalize the wake back to the caller agent's
    // main lane.

    it("infers sessionKey + agentId from the calling agent's session when neither is supplied", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-default", { action: "wake", text: "ping" });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toEqual({
        mode: "next-heartbeat",
        text: "ping",
        sessionKey: "agent:agent-123:telegram:direct:channing",
        agentId: "agent-123",
      });
    });

    it("rejects an explicit cross-agent sessionKey", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await expect(
        tool.execute("call-wake-cross-agent", {
          action: "wake",
          text: "follow up",
          sessionKey: "agent:agent-456:discord:thread-xyz",
        }),
      ).rejects.toThrow("automations sessionKey must match the calling agent");
      expect(callGatewayMock).not.toHaveBeenCalled();
    });

    it("rejects an explicit cross-agent agentId", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await expect(
        tool.execute("call-wake-cross-agent-id", {
          action: "wake",
          text: "follow up",
          agentId: "agent-456",
        }),
      ).rejects.toThrow("wake agentId must match the calling agent");
      expect(callGatewayMock).not.toHaveBeenCalled();
    });

    it("rejects a contradictory explicit agentId + agent-prefixed sessionKey pair", async () => {
      // The gateway target resolver treats agentId as authoritative, so a
      // contradictory pair would silently canonicalize the wake onto a session
      // the caller never named. The tool rejects instead of guessing.
      const tool = createTestCronTool();
      await expect(
        tool.execute("call-wake-explicit-pair", {
          action: "wake",
          text: "manual",
          sessionKey: "agent:agent-456:discord:thread-xyz",
          agentId: "ops",
        }),
      ).rejects.toThrow(/contradicts/);
      expect(callGatewayMock).not.toHaveBeenCalled();
    });

    it("accepts a different session owned by the calling agent", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-matching-pair", {
        action: "wake",
        text: "manual",
        sessionKey: "agent:agent-123:discord:thread-xyz",
        agentId: "agent-123",
      });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toEqual({
        mode: "next-heartbeat",
        text: "manual",
        sessionKey: "agent:agent-123:discord:thread-xyz",
        agentId: "agent-123",
      });
    });

    it("binds an unparseable explicit sessionKey to the calling agent", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-unparseable", {
        action: "wake",
        text: "x",
        sessionKey: "subagent:weird:format",
      });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toEqual({
        mode: "next-heartbeat",
        text: "x",
        sessionKey: "subagent:weird:format",
        agentId: "agent-123",
      });
    });

    it("requires text for action wake", async () => {
      // Mutation-test survivor: `required: true` -> false silently sent an
      // undefined-text wake. Pin the guard.
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await expect(tool.execute("call-wake-no-text", { action: "wake" })).rejects.toThrow();
      expect(callGatewayMock).not.toHaveBeenCalled();
    });

    it("sends a bare wake when no calling-session context exists", async () => {
      // Mutation-test survivor: `opts?.agentSessionKey` -> `opts.agentSessionKey`
      // crashed context-less callers. A tool created without session context
      // must fall through to default routing, not throw.
      const tool = createTestCronTool();
      await tool.execute("call-wake-no-context", { action: "wake", text: "ping" });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toEqual({ mode: "next-heartbeat", text: "ping" });
    });

    it('honours an explicit mode: "next-heartbeat"', async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-nh", { action: "wake", text: "tick", mode: "next-heartbeat" });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toMatchObject({ mode: "next-heartbeat", text: "tick" });
    });

    it('threads mode: "now" through unchanged', async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-now", { action: "wake", text: "ping", mode: "now" });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toMatchObject({ mode: "now", text: "ping" });
    });
  });

  it("documents deferred follow-up guidance in the tool description", () => {
    const tool = createTestCronTool();
    expect(tool.description).toContain("reminders, delayed self-wakeups, loops, recurring work");
    expect(tool.description).toContain("Never exec sleep/poll as timer.");
    expect(tool.description).toContain(
      "Inherited configured MCP authority includes only model-callable tools; interactive app-view-only capabilities are excluded from headless jobs.",
    );
    expect(tool.description).toContain(
      "the run stays detached, reads bounded chat context, then commits its final visible assistant result to this conversation's durable history",
    );
    expect(tool.description).toContain(
      "current=>canonical session commit, plus one normal channel send for external chats",
    );
    expect(tool.description).toContain(
      "WebChat observes that commit live and after reconnect without another user message",
    );
  });

  it("documents the event-trigger authoring contract", () => {
    const tool = createTestCronTool();

    expect(tool.description).toContain(
      "available unless cron.triggers.enabled=false — if off, say so; never model-poll instead",
    );
    expect(tool.description).toContain("Quiet headless check, no model");
    expect(tool.description).toContain("trigger.state");
    expect(tool.description).toContain("fire:false saves state only");
    expect(tool.description).toContain("fire:true runs payload");
    expect(tool.description).toContain("Fire on failures/timeouts too");
    expect(tool.description).toContain("success-only watchers look healthy when broken");
    expect(tool.description).toContain("dedupe via state, never memory");
    expect(tool.description).toContain("Script stays read-only; actions belong in payload");
    expect(tool.description).toContain("message is that run's entire context — self-contained");
    expect(tool.description).toContain('Silent watcher=>mode:"none"');
    expect(tool.description).toContain("once:true disables after first fire");
    expect(tool.description).toContain('await exec({command:"..."})');
  });

  it("documents due-by-default cron run mode", () => {
    const tool = createTestCronTool();
    const parameters = tool.parameters as SchemaLike;
    const runMode = parameters.properties?.runMode;

    expect(tool.description).toContain('run jobId (runMode "force"=now)');
    expect(runMode?.description).toContain('omitted defaults to "due"');
    expect(runMode?.description).toContain('use "force" to trigger now');
  });

  it("advertises delivery threadId in the tool schema", () => {
    const tool = createTestCronTool();
    const parameters = tool.parameters as SchemaLike;
    const jobThreadId = parameters.properties?.job?.properties?.delivery?.properties?.threadId;

    expect(jobThreadId?.description).toContain("Thread/topic id");
    expect(jobThreadId?.anyOf?.map((entry) => entry.type)).toEqual(["string", "number", "null"]);
  });

  it("advertises nullable cron update clears in the shared job schema", () => {
    const tool = createTestCronTool();
    const parameters = tool.parameters as SchemaLike;
    const job = parameters.properties?.job;
    const payload = job?.properties?.payload;
    const delivery = job?.properties?.delivery;
    const jobPacing = job?.properties?.pacing?.anyOf?.find((entry) => entry.type === "object");

    expect(parameters.properties?.patch).toBeUndefined();
    expect(job?.properties?.agentId?.anyOf?.map((entry) => entry.type)).toEqual(["string", "null"]);
    expect(job?.properties?.agentId?.type).toBeUndefined();
    expect(job?.properties?.agentId?.description).toContain("null to clear");
    expect(job?.properties?.sessionKey?.anyOf?.map((entry) => entry.type)).toEqual([
      "string",
      "null",
    ]);
    expect(job?.properties?.sessionKey?.type).toBeUndefined();
    expect(job?.properties?.sessionKey?.description).toContain("null to clear");
    expect(payload?.properties?.toolsAllow?.anyOf?.map((entry) => entry.type)).toEqual([
      "array",
      "null",
    ]);
    expect(payload?.properties?.toolsAllow?.type).toBeUndefined();
    expect(payload?.properties?.toolsAllow?.description).toContain("null to clear");
    expect(delivery?.properties?.channel?.anyOf?.map((entry) => entry.type)).toEqual([
      "string",
      "null",
    ]);
    expect(delivery?.properties?.channel?.type).toBeUndefined();
    expect(delivery?.properties?.channel?.description).toContain("null to clear");
    expect(delivery?.properties?.failureDestination?.anyOf?.map((entry) => entry.type)).toEqual([
      "object",
      "null",
    ]);
    expect(jobPacing?.description).toContain("at least one of min or max is required");
  });

  it.each([
    [
      "update",
      { action: "update", jobId: "job-1", job: { foo: "bar" } },
      { id: "job-1", patch: { foo: "bar" } },
    ],
    [
      "update",
      { action: "update", id: "job-2", job: { foo: "bar" } },
      { id: "job-2", patch: { foo: "bar" } },
    ],
    ["remove", { action: "remove", jobId: "job-1" }, { id: "job-1" }],
    ["remove", { action: "remove", id: "job-2" }, { id: "job-2" }],
    ["run", { action: "run", jobId: "job-1" }, { id: "job-1", mode: "due" }],
    ["run", { action: "run", id: "job-2" }, { id: "job-2", mode: "due" }],
    ["get", { action: "get", jobId: "job-1" }, { id: "job-1" }],
    ["get", { action: "get", id: "job-2" }, { id: "job-2" }],
    ["runs", { action: "runs", jobId: "job-1" }, { id: "job-1" }],
    ["runs", { action: "runs", id: "job-2" }, { id: "job-2" }],
  ])("%s sends id to gateway", async (action, args, expectedParams) => {
    const tool = createTestCronTool();
    await tool.execute("call1", args);

    const params = expectSingleGatewayCallMethod(`cron.${action}`);
    expect(params).toEqual(expectedParams);
  });

  it("prefers jobId over id when both are provided", async () => {
    const tool = createTestCronTool();
    await tool.execute("call1", {
      action: "run",
      jobId: "job-primary",
      id: "job-legacy",
    });

    expect(readGatewayCall().params).toEqual({
      id: "job-primary",
      mode: "due",
    });
  });

  it("supports due-only run mode", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-due", {
      action: "run",
      jobId: "job-due",
      runMode: "due",
    });

    expect(readGatewayCall().params).toEqual({
      id: "job-due",
      mode: "due",
    });
  });

  it("supports force run mode", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-force", {
      action: "run",
      jobId: "job-force",
      runMode: "force",
    });

    expect(readGatewayCall().params).toEqual({
      id: "job-force",
      mode: "force",
    });
  });

  it("normalizes cron.add job payloads", async () => {
    const tool = createTestCronTool();
    await tool.execute("call2", {
      action: "add",
      job: {
        data: {
          name: "wake-up",
          schedule: { atMs: 123 },
          payload: { kind: "systemEvent", text: "hello" },
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      name: "wake-up",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });
  });

  it("canonicalizes the inclusive Date maximum without losing service compatibility", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-date-max", {
      action: "add",
      job: {
        name: "far-future",
        schedule: { atMs: MAX_DATE_TIMESTAMP_MS },
        payload: { kind: "systemEvent", text: "hello" },
      },
    });

    expect(expectSingleGatewayCallMethod("cron.add")).toMatchObject({
      schedule: { kind: "at", at: new Date(MAX_DATE_TIMESTAMP_MS).toISOString() },
    });
  });

  it("preserves omitted declaration enablement and forwards explicit enablement", async () => {
    const tool = createTestCronTool();
    const baseJob = {
      name: "wake-up",
      declarationKey: "daily-wake",
      schedule: { at: new Date(123).toISOString() },
      payload: { kind: "systemEvent" as const, text: "hello" },
    };

    await tool.execute("call-declaration-default", { action: "add", job: baseJob });
    expect(readGatewayCall(0).params).not.toHaveProperty("enabled");

    await tool.execute("call-declaration-disabled", {
      action: "add",
      job: { ...baseJob, enabled: false },
    });
    expect(readGatewayCall(1).params).toMatchObject({ enabled: false });
  });

  it("rejects blank declaration keys before create normalization", async () => {
    const tool = createTestCronTool();
    await expect(
      tool.execute("call-blank-declaration", {
        action: "add",
        job: {
          name: "wake-up",
          declarationKey: "   ",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    ).rejects.toThrow("declarationKey must be a non-empty string");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects blank display names before create and patch normalization", async () => {
    const tool = createTestCronTool();
    await expect(
      tool.execute("call-blank-display-add", {
        action: "add",
        job: {
          name: "wake-up",
          declarationKey: "daily",
          displayName: "   ",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    ).rejects.toThrow("displayName must be a non-empty string");
    await expect(
      tool.execute("call-blank-display-update", {
        action: "update",
        jobId: "daily",
        job: { displayName: "   " },
      }),
    ).rejects.toThrow("displayName must be a non-empty string or null");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "add",
      {
        action: "add",
        job: { ...buildReminderAgentTurnJob(), pacing: {} },
      },
    ],
    [
      "update",
      {
        action: "update",
        jobId: "paced-job",
        job: { pacing: {} },
      },
    ],
  ])("rejects empty pacing on cron.%s before calling the gateway", async (_action, args) => {
    const tool = createTestCronTool();

    await expect(tool.execute("call-empty-pacing", args)).rejects.toThrow(
      "cron pacing requires at least one of min or max",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects null agentId on add from the scoped agent cron tool", async () => {
    const tool = createTestCronTool({ agentSessionKey: "main" });
    await expect(
      tool.execute("call-null", {
        action: "add",
        job: {
          name: "wake-up",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
          agentId: null,
        },
      }),
    ).rejects.toThrow("automation agentId must match the calling agent");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("preserves explicit agentId for sessionless cron add callers", async () => {
    const tool = createTestCronTool();

    await tool.execute("call-sessionless-add", {
      action: "add",
      job: {
        name: "worker job",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        agentId: "worker",
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toMatchObject({
      name: "worker job",
      agentId: "worker",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(params).not.toHaveProperty("callerScope");
  });

  it("infers session agentId when job.agentId is omitted", async () => {
    await expect(
      executeAddAndReadAgentId({
        callId: "call-omitted-agent-id",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      }),
    ).resolves.toBe("agent-123");
  });

  it("infers session agentId when job.agentId is undefined", async () => {
    await expect(
      executeAddAndReadAgentId({
        callId: "call-undefined-agent-id",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
        includeAgentId: true,
        agentId: undefined,
      }),
    ).resolves.toBe("agent-123");
  });

  it("accepts matching explicit agentId on add", async () => {
    await expect(
      executeAddAndReadAgentId({
        callId: "call-matching-agent-id",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
        includeAgentId: true,
        agentId: "agent-123",
      }),
    ).resolves.toBe("agent-123");
  });

  it("rejects foreign explicit agentId on add", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await expect(
      tool.execute("call-foreign-agent-id", {
        action: "add",
        job: {
          name: "foreign",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "agentTurn", message: "hello" },
          agentId: "worker",
        },
      }),
    ).rejects.toThrow("automation agentId must match the calling agent");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects foreign agent-prefixed session refs on add", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await expect(
      tool.execute("call-foreign-session-ref", {
        action: "add",
        job: {
          name: "foreign session",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "agentTurn", message: "hello" },
          sessionTarget: "session:agent:worker:telegram:direct:alice",
        },
      }),
    ).rejects.toThrow("automations sessionTarget must match the calling agent");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not forward model-supplied callerScope", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await tool.execute("call-spoofed-caller-scope", {
      action: "remove",
      jobId: "job-1",
      callerScope: { kind: "agentTool", agentId: "worker" },
    });

    expect(readGatewayCall().params).toEqual({
      id: "job-1",
    });
  });

  it("passes through failureAlert=false for add", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-disable-alerts-add", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        failureAlert: false,
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { failureAlert?: unknown }
      | undefined;
    expect(params?.failureAlert).toBe(false);
  });

  it.each([
    ["canonical", "command"],
    ["mixed-case", "Command"],
  ])("rejects %s command payloads from the agent cron tool on add", async (_case, kind) => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-command-add", {
        action: "add",
        job: {
          name: "command",
          schedule: { at: new Date(123).toISOString() },
          sessionTarget: "isolated",
          payload: { kind, argv: ["sh", "-lc", "echo ok"] },
        },
      }),
    ).rejects.toThrow("automation command payloads cannot be created or edited");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows script payloads without treating them as shell commands", async () => {
    const tool = createTestCronTool();

    await tool.execute("call-script-add", {
      action: "add",
      job: {
        name: "script",
        schedule: { at: new Date(123).toISOString() },
        sessionTarget: "isolated",
        payload: {
          kind: "script",
          script: "return { notify: 'done' }",
          timeoutSeconds: 300,
          toolBudget: 50,
        },
      },
    });

    expect(expectSingleGatewayCallMethod("cron.add")).toMatchObject({
      payload: {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 300,
        toolBudget: 50,
      },
    });
  });

  it("rejects on-exit schedules from the agent cron tool on add", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-on-exit-add", {
        action: "add",
        job: {
          name: "watch command",
          schedule: { kind: "on-exit", command: "make" },
          payload: { kind: "agentTurn", message: "done" },
        },
      }),
    ).rejects.toThrow("automation on-exit schedules cannot be created or edited");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("forwards stream schedules to the Gateway trigger-trust gate", async () => {
    const tool = createTestCronTool();

    await tool.execute("call-stream-add", {
      action: "add",
      job: {
        name: "watch events",
        schedule: {
          kind: "stream",
          command: ["node", "events.mjs"],
          mode: "match",
          match: "^ready:",
        },
        payload: { kind: "agentTurn", message: "handle events" },
      },
    });

    expect(expectSingleGatewayCallMethod("cron.add")?.schedule).toEqual({
      kind: "stream",
      command: ["node", "events.mjs"],
      mode: "match",
      match: "^ready:",
    });
  });

  it.each([
    ["delivery.channel", { channel: " ", to: "chat-1" }],
    ["delivery.channel", { channel: 123, to: "chat-1" }],
    ["delivery.to", { mode: "announce", channel: "telegram", to: " \t" }],
    ["delivery.to", { mode: "announce", channel: "telegram", to: {} }],
    [
      "delivery.failureDestination.to",
      { mode: "announce", failureDestination: { mode: "announce", to: " " } },
    ],
    [
      "delivery.failureDestination.to",
      { mode: "announce", failureDestination: { mode: "announce", to: false } },
    ],
    [
      "delivery.completionDestination.to",
      { mode: "announce", completionDestination: { mode: "webhook", to: "\n" } },
    ],
  ])("rejects invalid cron.add %s before gateway normalization", async (field, delivery) => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-blank-delivery-add", {
        action: "add",
        job: {
          name: "reminder",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "agentTurn", message: "hello" },
          delivery,
        },
      }),
    ).rejects.toThrow(`${field} must be a non-empty string`);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("recovers flattened add params for failureAlert and payload extras", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-flat-add-extras", {
      action: "add",
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      message: "hello",
      lightContext: true,
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      toolsAllow: [" exec ", " read "],
      failureAlert: { after: 3, cooldownMs: 60_000 },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | {
          payload?: {
            kind?: string;
            message?: string;
            lightContext?: boolean;
            fallbacks?: string[];
            toolsAllow?: string[];
          };
          failureAlert?: { after?: number; cooldownMs?: number };
        }
      | undefined;
    expect(params?.payload).toEqual({
      kind: "agentTurn",
      message: "hello",
      lightContext: true,
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
      toolsAllow: ["exec", "read"],
    });
    expect(params?.failureAlert).toEqual({ after: 3, cooldownMs: 60_000 });
  });

  it("caps agentTurn add toolsAllow to the creator tool surface", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });

    await tool.execute("call-capped-add-tools", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: {
          kind: "agentTurn",
          message: "hello",
          toolsAllow: ["exec", "read"],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload?.toolsAllow).toEqual(["read"]);
  });

  it("stores the creator tool surface on agentTurn adds without explicit toolsAllow", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });

    await tool.execute("call-default-capped-add-tools", {
      action: "add",
      job: buildReminderAgentTurnJob(),
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload?.toolsAllow).toEqual(["read", "automations"]);
  });

  it("lazily snapshots configured MCP authority for a default agentTurn add", async () => {
    const identities: unknown[] = [];
    callGatewayMock.mockImplementation(async () => {
      identities.push(getGatewayToolCallerIdentity());
      return { ok: true };
    });
    const resolveCreatorToolAuthority = vi.fn(async () =>
      resolvedCreatorAuthority(["read", "cron", "configured__lookup"]),
    );
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read", "cron"],
      resolveCreatorToolAuthority,
    });

    await tool.execute("call-default-configured-mcp", {
      action: "add",
      job: buildReminderAgentTurnJob(),
    });

    expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    expect(readGatewayCall().params).toMatchObject({
      payload: {
        toolsAllow: ["read", "automations", "configured__lookup"],
        toolsAllowIsDefault: true,
      },
    });
    expect(identities).toEqual([
      expect.objectContaining({ cronToolsAllowCapture: "final-executable-surface" }),
    ]);
  });

  it("does not write when the admitted run aborts while lazy authority resolves", async () => {
    let finishResolution!: () => void;
    const resolution = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const abortController = new AbortController();
    const run = runWithTestCronCreatorAuthority(
      "run-timeout",
      () => {
        const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
          runId: "run-timeout",
          resolve: async () => {
            await resolution;
            return {
              tools: ["read", "configured__lookup"],
              provenance: { version: 1, source: "final-executable-surface" },
            };
          },
          run: () => bindActiveCronCreatorAuthorityResolver("run-timeout"),
        });
        const tool = createTestCronTool({
          agentSessionKey: "agent:main:main",
          resolveCreatorToolAuthority,
        });
        return tool.execute("call-late-authority-timeout", {
          action: "add",
          job: buildReminderAgentTurnJob(),
        });
      },
      abortController.signal,
    );

    abortController.abort(new Error("run timed out"));
    finishResolution();
    await expect(run).rejects.toThrow();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not mint or write when the exact cron tool call aborts during discovery", async () => {
    let finishResolution!: () => void;
    let discoverySignal: AbortSignal | undefined;
    const resolution = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const operation = new AbortController();
    const run = runWithTestCronCreatorAuthority("run-operation-timeout", () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-operation-timeout",
        resolve: async (options) => {
          discoverySignal = options?.signal;
          await resolution;
          return {
            tools: ["read", "configured__lookup"],
            provenance: { version: 1, source: "final-executable-surface" },
          };
        },
        run: () => bindActiveCronCreatorAuthorityResolver("run-operation-timeout"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      return tool.execute(
        "call-operation-authority-timeout",
        { action: "add", job: buildReminderAgentTurnJob() },
        operation.signal,
      );
    });

    operation.abort(new Error("cron tool call timed out"));
    finishResolution();

    await expect(run).rejects.toThrow("cron tool call timed out");
    expect(discoverySignal?.aborted).toBe(true);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("lets a later cron operation rematerialize after an earlier operation abort", async () => {
    let finishFirstResolution!: () => void;
    const firstResolution = new Promise<void>((resolve) => {
      finishFirstResolution = resolve;
    });
    let materializations = 0;
    callGatewayMock.mockImplementation(async () => {
      const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
      expect(grant).toBeDefined();
      consumeCronCreatorAuthorityGrant(grant!);
      return { ok: true };
    });

    await runWithTestCronCreatorAuthority("run-operation-retry", async () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-operation-retry",
        resolve: async () => {
          materializations += 1;
          if (materializations === 1) {
            await firstResolution;
          }
          return {
            tools: ["read", "configured__lookup"],
            provenance: { version: 1, source: "final-executable-surface" },
          };
        },
        run: () => bindActiveCronCreatorAuthorityResolver("run-operation-retry"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      const firstOperation = new AbortController();
      const firstWrite = tool.execute(
        "call-operation-retry-first",
        { action: "add", job: buildReminderAgentTurnJob() },
        firstOperation.signal,
      );
      firstOperation.abort(new Error("first cron call timed out"));
      finishFirstResolution();
      await expect(firstWrite).rejects.toThrow("first cron call timed out");
      expect(callGatewayMock).not.toHaveBeenCalled();

      await tool.execute(
        "call-operation-retry-second",
        { action: "add", job: buildReminderAgentTurnJob() },
        new AbortController().signal,
      );
    });

    expect(materializations).toBe(2);
    expect(callGatewayMock).toHaveBeenCalledOnce();
  });

  it("does not commit when the exact cron tool call aborts after grant mint", async () => {
    const operation = new AbortController();
    let committedWrites = 0;
    callGatewayMock.mockImplementation(async () => {
      const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
      expect(grant).toBeDefined();
      operation.abort(new Error("cron tool call timed out before commit"));
      consumeCronCreatorAuthorityGrant(grant!);
      committedWrites += 1;
      return { ok: true };
    });
    const run = runWithTestCronCreatorAuthority("run-abort-before-commit", () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-abort-before-commit",
        resolve: async () => ({
          tools: ["read", "configured__lookup"],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => bindActiveCronCreatorAuthorityResolver("run-abort-before-commit"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      return tool.execute(
        "call-abort-before-commit",
        { action: "add", job: buildReminderAgentTurnJob() },
        operation.signal,
      );
    });

    await expect(run).rejects.toThrow("Configured MCP cron authority is no longer active");
    expect(committedWrites).toBe(0);
  });

  it("fails a queued configured-MCP default add visibly without writing", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read", "cron"],
      creatorAuthorityUnavailableReason: "queued-local-operator-configured-mcp",
    });

    await expect(
      tool.execute("call-queued-configured-mcp-add", {
        action: "add",
        job: buildReminderAgentTurnJob(),
      }),
    ).rejects.toThrow("fresh authenticated direct-local operator turn");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    ["finite", ["read"]],
    ["empty", []],
  ])("keeps an explicit %s add offline and exact", async (_label, toolsAllow) => {
    const resolveCreatorToolAuthority = vi.fn(async () => {
      throw new Error("must stay offline");
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read", "cron"],
      resolveCreatorToolAuthority,
    });

    await tool.execute("call-explicit-configured-mcp", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: { kind: "agentTurn", message: "hello", toolsAllow },
      },
    });

    expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
    expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow } });
  });

  it("resolves an unknown finite add name and cannot pre-authorize a future tool", async () => {
    const resolveCreatorToolAuthority = vi.fn(async () => resolvedCreatorAuthority(["read"]));
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read"],
      resolveCreatorToolAuthority,
    });

    await tool.execute("call-future-configured-mcp", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["future__tool"] },
      },
    });

    expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: [] } });
  });

  it("keeps future-tool prevention for complete runtimes without a capture marker", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read"],
    });

    await tool.execute("call-future-no-capture-marker", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["future__tool"] },
      },
    });

    expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: [] } });
  });

  it("resolves symbolic groups before persisting an add cap", async () => {
    const resolveCreatorToolAuthority = vi.fn(async () =>
      resolvedCreatorAuthority(["read", { name: "configured__lookup", pluginId: "bundle-mcp" }]),
    );
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      resolveCreatorToolAuthority,
    });

    await tool.execute("call-symbolic-configured-mcp", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["group:plugins"] },
      },
    });

    expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    expect(readGatewayCall().params).toMatchObject({
      payload: { toolsAllow: ["configured__lookup"] },
    });
  });

  it("does not write a default add when configured MCP authentication fails", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      resolveCreatorToolAuthority: async () => {
        throw new Error("Sign in to configured MCP, then retry; no automation changes were saved.");
      },
    });

    await expect(
      tool.execute("call-default-auth-failure", {
        action: "add",
        job: buildReminderAgentTurnJob(),
      }),
    ).rejects.toThrow("no automation changes were saved");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("fails incomplete inherited and unknown finite adds while preserving known finite tools", async () => {
    const captureRef = {};
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
      creatorToolAllowlistCaptureRef: captureRef,
    });

    await expect(
      tool.execute("call-default-capture-unavailable", {
        action: "add",
        job: buildReminderAgentTurnJob(),
      }),
    ).rejects.toThrow("fresh authenticated direct-local operator turn");
    expect(callGatewayMock).not.toHaveBeenCalled();

    await expect(
      tool.execute("call-unknown-finite-capture-unavailable", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          payload: {
            kind: "agentTurn",
            message: "hello",
            toolsAllow: ["future__tool"],
          },
        },
      }),
    ).rejects.toThrow("CLI or Gateway with an explicit finite toolsAllow list");
    expect(callGatewayMock).not.toHaveBeenCalled();

    await tool.execute("call-explicit-capture-unavailable", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
      },
    });
    expect(expectSingleGatewayCallMethod("cron.add")).toMatchObject({
      payload: { toolsAllow: ["read"] },
    });
  });

  it("caps trigger-script systemEvent adds to the creator tool surface", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });

    await tool.execute("call-capped-trigger-system-event", {
      action: "add",
      job: {
        name: "watcher",
        schedule: { kind: "every", everyMs: 60_000 },
        trigger: { script: "return { fire: false }" },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "changed" },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload?.toolsAllow).toEqual(["read", "automations"]);
  });

  it("infers systemEvent for implicit text payloads with toolsAllow", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const tool = createTestCronTool();

    await tool.execute("call-implicit-system-event-tools", {
      action: "add",
      job: {
        name: "implicit system event",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        payload: { text: "tick", toolsAllow: ["read"] },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { kind?: string; text?: string; toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload).toEqual({
      kind: "systemEvent",
      text: "tick",
      toolsAllow: ["read"],
    });
  });

  it("caps trigger-script systemEvent updates to the creator tool surface", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-trigger",
        payload: { kind: "systemEvent", text: "changed" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });

    await tool.execute("call-capped-trigger-system-event-update", {
      action: "update",
      id: "job-trigger",
      job: { trigger: { script: "return { fire: false }" } },
    });

    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-trigger",
        expectedConfigRevision: "sha256:test",
        patch: {
          trigger: { script: "return { fire: false }" },
          payload: {
            kind: "systemEvent",
            toolsAllow: ["read", "automations"],
            toolsAllowIsDefault: true,
          },
        },
      },
    });
  });

  it("caps dormant systemEvent toolsAllow updates without relying on trigger state", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });

    await tool.execute("call-capped-dormant-system-event-update", {
      action: "update",
      id: "job-dormant",
      job: {
        payload: { kind: "systemEvent", toolsAllow: ["read", "exec"] },
      },
    });

    expect(readGatewayCall()).toEqual({
      method: "cron.update",
      params: {
        id: "job-dormant",
        patch: { payload: { kind: "systemEvent", toolsAllow: ["read"] } },
      },
    });
  });

  it("preserves explicit empty agentTurn add toolsAllow under a creator tool surface", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });

    await tool.execute("call-empty-capped-add-tools", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: {
          kind: "agentTurn",
          message: "hello",
          toolsAllow: [],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload?.toolsAllow).toEqual([]);
  });

  it("expands plugin selectors against the creator tool surface on agentTurn adds", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: [
        { name: "active_memory_search", pluginId: "active-memory" },
        { name: "active_memory_store", pluginId: "active-memory" },
        { name: "cron" },
      ],
    });

    await tool.execute("call-capped-add-plugin-tools", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: {
          kind: "agentTurn",
          message: "hello",
          toolsAllow: ["active-memory", "cron", "exec"],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload?.toolsAllow).toEqual([
      "active_memory_search",
      "active_memory_store",
      "automations",
    ]);
  });

  it("expands group:plugins against the creator tool surface on agentTurn adds", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: [
        { name: "active_memory_search", pluginId: "active-memory" },
        { name: "cron" },
      ],
    });

    await tool.execute("call-capped-add-plugin-group", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: {
          kind: "agentTurn",
          message: "hello",
          toolsAllow: ["group:plugins"],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload?.toolsAllow).toEqual(["active_memory_search"]);
  });

  it("recovers concatenated cron add keys from local tool-call parsers", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-concatenated-add", {
      action: "add",
      job: {
        delivery: { mode: "none" },
        enabled: true,
        namePayload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
        scheduleKind: { everyMs: 999_999, kind: "every" },
        sessionTargetName: "evidence-test",
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      delivery: { mode: "none" },
      enabled: true,
      name: "evidence-test",
      payload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      schedule: { everyMs: 999_999, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
  });

  it("recovers flat concatenated cron add keys from local tool-call parsers", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-flat-concatenated-add", {
      action: "add",
      delivery: { mode: "none" },
      enabled: true,
      namePayload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      scheduleKind: { everyMs: 999_999, kind: "every" },
      sessionTargetName: "evidence-test",
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      delivery: { mode: "none" },
      enabled: true,
      name: "evidence-test",
      payload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      schedule: { everyMs: 999_999, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
  });

  it("stamps cron.add with caller sessionKey when missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const callerSessionKey = "agent:main:discord:channel:ops";
    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-session-key",
      agentSessionKey: callerSessionKey,
    });
    expect(sessionKey).toBe(callerSessionKey);
  });

  it("defaults scoped agentTurn adds to the creating conversation", async () => {
    const callerSessionKey = "agent:main:discord:channel:ops";
    const tool = createTestCronTool({ agentSessionKey: callerSessionKey });

    await tool.execute("call-current-default", {
      action: "add",
      job: buildReminderAgentTurnJob(),
    });

    expect(expectSingleGatewayCallMethod("cron.add")).toMatchObject({
      sessionTarget: "current",
      sessionKey: callerSessionKey,
      delivery: { mode: "announce" },
    });
  });

  it("forwards authenticated source account separately from delivery account", async () => {
    let identity: ReturnType<typeof getGatewayToolCallerIdentity> = undefined;
    const tool = createCronTool(
      {
        agentSessionKey: "agent:main:discord:channel:ops",
        agentAccountId: "source-account",
        selfRemoveOnlyJobId: "job-current",
        currentDeliveryContext: { accountId: "delivery-account" },
      },
      {
        callGatewayTool: async <T>() => {
          identity = getGatewayToolCallerIdentity();
          return { enabled: true, jobs: 0 } as T;
        },
      },
    );

    await tool.execute("call-source-account", { action: "status" });

    expect(identity).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      turnSourceAccountId: "source-account",
      cronSelfManagementJobId: "job-current",
    });
  });

  it("preserves explicit job.sessionKey on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-explicit-session-key",
      agentSessionKey: "agent:main:discord:channel:ops",
      jobSessionKey: "agent:main:telegram:group:-100123:topic:99",
    });
    expect(sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("does not stamp caller sessionKey when add targets isolated session", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({ agentSessionKey: "agent:main:webchat:dm:dashboard" });
    await tool.execute("call-isolated-no-stamp", {
      action: "add",
      job: {
        name: "isolated run",
        schedule: { at: new Date(123).toISOString() },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "hello" },
      },
    });
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string; sessionTarget?: string } | undefined;
    expect(payload?.sessionTarget).toBe("isolated");
    expect(payload).not.toHaveProperty("sessionKey");
  });

  it("adds recent context for systemEvent reminders when contextMessages > 0", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: [{ type: "text", text: "Discussed Q2 budget" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "We agreed to review on Tuesday." }],
          },
          { role: "user", content: [{ type: "text", text: "Remind me about the thing at 2pm" }] },
        ],
      })
      .mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call3", 3);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");

    const cronCall = readGatewayCall(1);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(1);
    expect(text).toContain("Recent context:");
    expect(text).toContain("User: Discussed Q2 budget");
    expect(text).toContain("Assistant: We agreed to review on Tuesday.");
    expect(text).toContain("User: Remind me about the thing at 2pm");
  });

  it("caps contextMessages at 10", async () => {
    const messages = Array.from({ length: 12 }, (_, idx) => ({
      role: "user",
      content: [{ type: "text", text: `Message ${idx + 1}` }],
    }));
    callGatewayMock.mockResolvedValueOnce({ messages }).mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call5", 20);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");
    const historyParams = historyCall.params as { limit?: number } | undefined;
    expect(historyParams?.limit).toBe(10);

    const text = readCronPayloadText(1);
    expect(text).not.toMatch(/Message 1\\b/);
    expect(text).not.toMatch(/Message 2\\b/);
    expect(text).toContain("Message 3");
    expect(text).toContain("Message 12");
  });

  it.each([1.5, -1, "2messages"])(
    "rejects invalid contextMessages value %s",
    async (contextMessages) => {
      const tool = createTestCronTool({ agentSessionKey: "main" });

      await expect(
        tool.execute("call-invalid-context", {
          action: "add",
          contextMessages,
          job: {
            name: "reminder",
            schedule: { at: new Date(123).toISOString() },
            payload: { kind: "systemEvent", text: "Reminder: the thing." },
          },
        }),
      ).rejects.toThrow("contextMessages must be a non-negative integer");
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("does not add context when contextMessages is 0 (default)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({ agentSessionKey: "main" });
    await tool.execute("call4", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { text: "Reminder: the thing." },
      },
    });

    // Should only call cron.add, not chat.history
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const cronCall = readGatewayCall(0);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(0);
    expect(text).not.toContain("Recent context:");
  });

  it("rejects explicit agentId null on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({ agentSessionKey: "main" });
    await expect(
      tool.execute("call6", {
        action: "add",
        job: {
          name: "reminder",
          schedule: { at: new Date(123).toISOString() },
          agentId: null,
          payload: { kind: "systemEvent", text: "Reminder: the thing." },
        },
      }),
    ).rejects.toThrow("automation agentId must match the calling agent");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("strips null clears from add jobs before the strict gateway create contract (#121606)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const tool = createTestCronTool();

    await tool.execute("call-add-null-clears", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        displayName: null,
        pacing: null,
        trigger: null,
        sessionKey: null,
        payload: { kind: "agentTurn", message: "hello", model: null, fallbacks: null },
        delivery: { mode: "announce", channel: null, failureDestination: null },
      },
    });

    const call = readGatewayCall();
    expect(call.method).toBe("cron.add");
    const params = call.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("displayName");
    expect(params).not.toHaveProperty("pacing");
    expect(params).not.toHaveProperty("trigger");
    // Null sessionKey stays: cron.add accepts it and it suppresses default
    // creator-session binding.
    expect(params.sessionKey).toBeNull();
    expect(params.payload).not.toHaveProperty("model");
    expect(params.payload).not.toHaveProperty("fallbacks");
    expect(params.delivery).not.toHaveProperty("channel");
    expect(params.delivery).not.toHaveProperty("failureDestination");
  });

  it("does not infer delivery from raw session-key fragments without delivery context", async () => {
    const slackDelivery = await executeAddAndReadDelivery({
      callId: "call-thread",
      agentSessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
    });
    const telegramDelivery = await executeAddAndReadDelivery({
      callId: "call-telegram-topic",
      agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
    });

    expect(slackDelivery?.channel).toBeUndefined();
    expect(slackDelivery?.to).toBeUndefined();
    expect(telegramDelivery?.channel).toBeUndefined();
    expect(telegramDelivery?.to).toBeUndefined();
  });

  it("uses stored delivery context when current context is unavailable", async () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "matrix",
        to: "room:!AbCdEf1234567890:example.org",
        accountId: "bot-a",
        threadId: "$RootEvent:Example.Org",
      },
      threadId: undefined,
    });

    expect(
      await executeAddAndReadDelivery({
        callId: "call-stored-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "room:!AbCdEf1234567890:example.org",
      accountId: "bot-a",
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("prefers current delivery context over stored session context", async () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "matrix",
        to: "!stored:example.org",
      },
      threadId: undefined,
    });

    expect(
      await executeAddAndReadDelivery({
        callId: "call-current-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "room:!AbCdEf1234567890:example.org",
          accountId: "bot-a",
          threadId: "$RootEvent:Example.Org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "room:!AbCdEf1234567890:example.org",
      accountId: "bot-a",
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("does not surface lowercased LINE recipients when current delivery context is unavailable (#81628)", async () => {
    // LINE chat IDs are case-sensitive; without current/persisted deliveryContext,
    // cron must not rebuild delivery.to from the lowercased session-key fragment.
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "line",
      peerKind: "group",
      peerId: "Cabcdef0123456789abcdef0123456789",
    });
    expect(sessionKey).toBe("agent:main:line:group:cabcdef0123456789abcdef0123456789");

    const delivery = await executeAddAndReadDelivery({
      callId: "call-line-group-no-context-81628",
      agentSessionKey: sessionKey,
      // Intentionally no currentDeliveryContext.
    });

    expect(delivery?.to).toBeUndefined();
  });

  it("does not surface lowercased LINE DM recipients with per-account-channel-peer scope (#81628)", async () => {
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "line",
      peerKind: "direct",
      accountId: "primary",
      dmScope: "per-account-channel-peer",
      peerId: "Uabcdef0123456789abcdef0123456789",
    });
    expect(sessionKey).toBe("agent:main:line:primary:direct:uabcdef0123456789abcdef0123456789");

    const delivery = await executeAddAndReadDelivery({
      callId: "call-line-direct-no-context-81628",
      agentSessionKey: sessionKey,
    });

    expect(delivery?.to).toBeUndefined();
  });

  it("does not surface lowercased LINE DM recipients with per-peer scope (#81628)", async () => {
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "line",
      peerKind: "direct",
      dmScope: "per-peer",
      peerId: "Uabcdef0123456789abcdef0123456789",
    });
    expect(sessionKey).toBe("agent:main:direct:uabcdef0123456789abcdef0123456789");

    const delivery = await executeAddAndReadDelivery({
      callId: "call-line-per-peer-no-context-81628",
      agentSessionKey: sessionKey,
    });

    expect(delivery?.to).toBeUndefined();
  });

  it("does not let current delivery context override explicit delivery targets", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-explicit-target-wins",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "room:!AbCdEf1234567890:example.org",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-100123",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });
  });

  it("keeps explicit delivery account and thread while filling target from context", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-explicit-delivery-fields-win",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
          accountId: "context-bot",
          threadId: "$ContextThread:Example.Org",
        },
        delivery: {
          mode: "announce",
          accountId: "explicit-bot",
          threadId: "$ExplicitThread:Example.Org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
      accountId: "explicit-bot",
      threadId: "$ExplicitThread:Example.Org",
    });
  });

  it("trims current context fields without changing provider target casing", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-trim-current-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: " Matrix ",
          to: "  !AbCdEf1234567890:Example.Org  ",
          accountId: " Bot-A ",
          threadId: "  $RootEvent:Example.Org  ",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:Example.Org",
      accountId: "bot-a",
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("infers delivery from current context even when no session key is available", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-context-no-session",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
    });
  });

  it("uses current delivery context when delivery is null", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-null-delivery-current-context",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
        delivery: null,
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
    });
  });

  it("falls back to stored delivery context when current context has no target", async () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "telegram",
        to: "-1001234567890",
      },
      threadId: "99",
    });

    expect(
      await executeAddAndReadDelivery({
        callId: "call-empty-current-context",
        agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
        currentDeliveryContext: {
          channel: "matrix",
          to: "   ",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });

  it("does not infer current delivery context when delivery mode is none", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-current-context-mode-none",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
        delivery: { mode: "none" },
      }),
    ).toEqual({ mode: "none" });
  });

  it("infers delivery when delivery is null", async () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        to: "alice",
      },
      threadId: undefined,
    });

    expect(
      await executeAddAndReadDelivery({
        callId: "call-null-delivery",
        agentSessionKey: "agent:main:dm:alice",
        delivery: null,
      }),
    ).toEqual({
      mode: "announce",
      to: "alice",
    });
  });

  // ── Flat-params recovery (issue #11310) ──────────────────────────────

  it("recovers flat params when job is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-flat", {
      action: "add",
      name: "flat-job",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "do stuff" },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { name?: string; sessionTarget?: string; payload?: { kind?: string } }
      | undefined;
    expect(params?.name).toBe("flat-job");
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("recovers flat params when job is empty object", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-empty-job", {
      action: "add",
      job: {},
      name: "empty-job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "wake up" },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { name?: string; sessionTarget?: string; payload?: { text?: string } }
      | undefined;
    expect(params?.name).toBe("empty-job");
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.text).toBe("wake up");
  });

  it("recovers flat message shorthand as agentTurn payload", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-msg-shorthand", {
      action: "add",
      schedule: { kind: "at", at: new Date(456).toISOString() },
      message: "do stuff",
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { kind?: string; message?: string }; sessionTarget?: string }
      | undefined;
    // normalizeCronJobCreate infers agentTurn from message and isolated from agentTurn
    expect(params?.payload?.kind).toBe("agentTurn");
    expect(params?.payload?.message).toBe("do stuff");
    expect(params?.sessionTarget).toBe("isolated");
  });

  it("recovers flat text and toolsAllow as a systemEvent payload", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-flat-system-event-cap", {
      action: "add",
      name: "flat-system-event",
      schedule: { kind: "every", everyMs: 60_000 },
      text: "tick",
      toolsAllow: [" read ", " cron "],
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { kind?: string; text?: string; toolsAllow?: string[] } }
      | undefined;
    expect(params?.payload).toEqual({
      kind: "systemEvent",
      text: "tick",
      toolsAllow: ["read", "cron"],
    });
  });

  it("does not recover flat params when no meaningful job field is present", async () => {
    const tool = createTestCronTool();
    await expect(
      tool.execute("call-no-signal", {
        action: "add",
        name: "orphan-name",
        enabled: true,
      }),
    ).rejects.toThrow("job required");
  });

  it("prefers existing non-empty job over flat params", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-nested-wins", {
      action: "add",
      job: {
        name: "nested-job",
        schedule: { kind: "at", at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "from nested" },
      },
      name: "flat-name-should-be-ignored",
    });

    const call = readGatewayCall();
    expect(call?.params?.name).toBe("nested-job");
    expect((call?.params?.payload as { text?: string } | undefined)?.text).toBe("from nested");
  });

  it("does not infer delivery when mode is none", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-none",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "none" },
    });
    expect(delivery).toEqual({ mode: "none" });
  });

  it("preserves explicit mode-less delivery objects for add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const delivery = await executeAddAndReadDelivery({
      callId: "call-implicit-announce",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { channel: "telegram", to: "123" },
    });
    expect(delivery).toEqual({
      channel: "telegram",
      to: "123",
    });
  });

  it("does not infer announce delivery when mode is webhook", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-webhook-explicit",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    });
    expect(delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("fails fast when webhook mode is missing delivery.to", async () => {
    const tool = createTestCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-missing", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          delivery: { mode: "webhook" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("fails fast when webhook mode uses a non-http URL", async () => {
    const tool = createTestCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-invalid", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("recovers flat patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat", {
      action: "update",
      jobId: "job-1",
      name: "new-name",
      enabled: false,
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { name?: string; enabled?: boolean } }
      | undefined;
    expect(params?.id).toBe("job-1");
    expect(params?.patch?.name).toBe("new-name");
    expect(params?.patch?.enabled).toBe(false);
  });

  it.each([
    ["delivery.channel", { channel: " " }],
    ["delivery.channel", { channel: 123 }],
    ["delivery.to", { to: " " }],
    ["delivery.to", { to: {} }],
    ["delivery.failureDestination.to", { failureDestination: { to: " " } }],
    ["delivery.failureDestination.to", { failureDestination: { to: false } }],
    ["delivery.completionDestination.to", { completionDestination: { mode: "webhook", to: " " } }],
  ])("rejects invalid cron.update %s before gateway normalization", async (field, delivery) => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-blank-delivery-update", {
        action: "update",
        id: "job-blank-delivery",
        job: { delivery },
      }),
    ).rejects.toThrow(`${field} must be a non-empty string`);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes nullable cron.update delivery clears through to the gateway", async () => {
    const tool = createTestCronTool();
    await tool.execute("call-null-delivery-update", {
      action: "update",
      id: "job-clear-delivery",
      job: {
        delivery: {
          channel: null,
          to: null,
          failureDestination: null,
          completionDestination: null,
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { delivery?: unknown } }
      | undefined;
    expect(params).toEqual({
      id: "job-clear-delivery",
      patch: {
        delivery: {
          channel: null,
          to: null,
          failureDestination: null,
          completionDestination: null,
        },
      },
    });
  });

  it("rejects agentId retargeting on update", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await expect(
      tool.execute("call-update-agent-id", {
        action: "update",
        id: "job-1",
        job: { agentId: "worker" },
      }),
    ).rejects.toThrow("automation patch agentId cannot be changed");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows unscoped operator cron.update agentId retargeting", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const tool = createTestCronTool();

    await tool.execute("call-unscoped-update-agent-id", {
      action: "update",
      id: "job-1",
      job: { agentId: "worker" },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { agentId?: string } }
      | undefined;
    expect(params).toEqual({
      id: "job-1",
      patch: { agentId: "worker" },
    });
  });

  it("rejects foreign sessionTarget retargeting on update", async () => {
    const tool = createTestCronTool({
      agentSessionKey: "agent:agent-123:telegram:direct:channing",
    });

    await expect(
      tool.execute("call-update-session-target", {
        action: "update",
        id: "job-1",
        job: { sessionTarget: "session:agent:worker:telegram:direct:alice" },
      }),
    ).rejects.toThrow("automations sessionTarget must match the calling agent");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("recovers additional flat patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-extra", {
      action: "update",
      id: "job-2",
      sessionTarget: "main",
      failureAlert: { after: 3, cooldownMs: 60_000 },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            sessionTarget?: string;
            failureAlert?: { after?: number; cooldownMs?: number };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-2");
    expect(params?.patch?.sessionTarget).toBe("main");
    expect(params?.patch?.failureAlert).toEqual({ after: 3, cooldownMs: 60_000 });
  });
  it("passes through failureAlert=false for update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-disable-alerts", {
      action: "update",
      id: "job-4",
      job: { failureAlert: false },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { failureAlert?: unknown } }
      | undefined;
    expect(params?.id).toBe("job-4");
    expect(params?.patch?.failureAlert).toBe(false);
  });

  it.each([
    ["canonical", "command"],
    ["mixed-case", "Command"],
  ])("rejects %s command payloads from the agent cron tool on update", async (_case, kind) => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-command-update", {
        action: "update",
        id: "job-4",
        job: {
          payload: { kind, argv: ["sh", "-lc", "echo ok"] },
        },
      }),
    ).rejects.toThrow("automation command payloads cannot be created or edited");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects kind-less edits to stored command payloads", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-command",
      trigger: { script: "json({ fire: true })" },
      payload: { kind: "command", argv: ["echo", "before"] },
    });
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-kindless-command-update", {
        action: "update",
        id: "job-command",
        job: {
          payload: { argv: ["sh", "-lc", "echo bypass"] },
        },
      }),
    ).rejects.toThrow("automation command payloads cannot be created or edited");

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({
      method: "cron.get",
      params: { id: "job-command" },
    });
  });

  it("allows non-payload updates to triggered command jobs", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const tool = createTestCronTool({ creatorToolAllowlist: ["read", "cron"] });

    await tool.execute("call-command-disable", {
      action: "update",
      id: "job-command",
      job: { enabled: false },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({
      method: "cron.update",
      params: {
        id: "job-command",
        patch: { enabled: false },
      },
    });
  });

  it("rejects on-exit schedules from the agent cron tool on update", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-on-exit-update", {
        action: "update",
        id: "job-4",
        job: {
          schedule: { kind: "on-exit", command: "make" },
        },
      }),
    ).rejects.toThrow("automation on-exit schedules cannot be created or edited");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("recovers flattened payload patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-payload", {
      action: "update",
      id: "job-3",
      message: "run report",
      model: " openrouter/deepseek/deepseek-r1 ",
      thinking: " high ",
      timeoutSeconds: 45,
      lightContext: true,
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              message?: string;
              model?: string;
              thinking?: string;
              timeoutSeconds?: number;
              lightContext?: boolean;
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-3");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      message: "run report",
      model: "openrouter/deepseek/deepseek-r1",
      thinking: "high",
      timeoutSeconds: 45,
      lightContext: true,
    });
  });

  it("recovers flattened model-only payload patch params for update action", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-5",
        configRevision: "sha256:model-only",
        payload: { kind: "agentTurn", message: "before" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-model-only", {
      action: "update",
      id: "job-5",
      model: " openrouter/deepseek/deepseek-r1 ",
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      toolsAllow: [" exec ", " read "],
    });

    const params = readGatewayCall(1).params as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              model?: string;
              fallbacks?: string[];
              toolsAllow?: string[];
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-5");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      model: "openrouter/deepseek/deepseek-r1",
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
      toolsAllow: ["exec", "read"],
    });
  });

  it("recovers a flattened toolsAllow-only systemEvent patch", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-flat-system-event-cap",
        payload: { kind: "systemEvent", text: "before", toolsAllow: ["read"] },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-system-event-cap", {
      action: "update",
      id: "job-flat-system-event-cap",
      toolsAllow: [" cron "],
    });

    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-flat-system-event-cap",
        expectedConfigRevision: "sha256:test",
        patch: { payload: { kind: "systemEvent", toolsAllow: ["cron"] } },
      },
    });
  });

  it("recovers concatenated cron update keys from local tool-call parsers", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-concatenated", {
      action: "update",
      id: "job-concat",
      job: {
        namePayload: { kind: "agentTurn", message: "Updated prompt.", timeoutSeconds: 20 },
        scheduleKind: { everyMs: 60_000, kind: "every" },
        sessionTargetName: "updated-name",
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            name?: string;
            payload?: { kind?: string; message?: string; timeoutSeconds?: number };
            schedule?: { kind?: string; everyMs?: number };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-concat");
    expect(params?.patch).toEqual({
      name: "updated-name",
      payload: { kind: "agentTurn", message: "Updated prompt.", timeoutSeconds: 20 },
      schedule: { everyMs: 60_000, kind: "every" },
    });
  });

  it("recovers flat concatenated cron update keys from local tool-call parsers", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-flat-concatenated", {
      action: "update",
      id: "job-concat",
      namePayload: { kind: "agentTurn", message: "Updated prompt.", timeoutSeconds: 20 },
      scheduleKind: { everyMs: 60_000, kind: "every" },
      sessionTargetName: "updated-name",
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            name?: string;
            payload?: { kind?: string; message?: string; timeoutSeconds?: number };
            schedule?: { kind?: string; everyMs?: number };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-concat");
    expect(params?.patch).toEqual({
      name: "updated-name",
      payload: { kind: "agentTurn", message: "Updated prompt.", timeoutSeconds: 20 },
      schedule: { everyMs: 60_000, kind: "every" },
    });
  });

  it("uses flat string scheduleKind without leaking it to cron update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-string-schedule-kind", {
      action: "update",
      id: "job-kind",
      expr: "0 8 * * *",
      scheduleKind: "cron",
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: { schedule?: { kind?: string; expr?: string }; scheduleKind?: unknown };
        }
      | undefined;
    expect(params?.id).toBe("job-kind");
    expect(params?.patch).toEqual({ schedule: { expr: "0 8 * * *", kind: "cron" } });
    expect(params?.patch?.scheduleKind).toBeUndefined();
  });

  it("rejects malformed flattened fallback-only payload patch params for update action", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-update-flat-invalid-fallbacks", {
        action: "update",
        id: "job-9",
        fallbacks: [123],
      }),
    ).rejects.toThrow("job required");
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("rejects malformed flattened toolsAllow-only payload patch params for update action", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-update-flat-invalid-tools", {
        action: "update",
        id: "job-10",
        toolsAllow: [123],
      }),
    ).rejects.toThrow("job required");
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("infers kind for nested fallback-only payload patches on update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-nested-fallbacks-only", {
      action: "update",
      id: "job-6",
      job: {
        payload: {
          fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              fallbacks?: string[];
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-6");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
    });
  });

  it("infers kind for nested toolsAllow-only payload patches on update", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-7",
        payload: { kind: "agentTurn", message: "before" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-nested-tools-only", {
      action: "update",
      id: "job-7",
      job: {
        payload: {
          toolsAllow: [" exec ", " read "],
        },
      },
    });

    const params = readGatewayCall(1).params as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              toolsAllow?: string[];
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-7");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      toolsAllow: ["exec", "read"],
    });
  });

  it("preserves null toolsAllow payload patches on update", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-8",
        payload: { kind: "agentTurn", message: "before" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-clear-tools", {
      action: "update",
      id: "job-8",
      job: {
        payload: {
          toolsAllow: null,
        },
      },
    });

    const params = readGatewayCall(1).params as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              toolsAllow?: string[] | null;
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-8");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      toolsAllow: null,
    });
  });

  it("resolves toolsAllow-only patches from existing systemEvent payloads", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-system-event",
        payload: { kind: "systemEvent", text: "before", toolsAllow: ["read"] },
      })
      .mockResolvedValueOnce({ ok: true });
    const tool = createTestCronTool();

    await tool.execute("call-update-system-event-tools", {
      action: "update",
      id: "job-system-event",
      job: { payload: { toolsAllow: ["cron"] } },
    });

    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-system-event",
        expectedConfigRevision: "sha256:test",
        patch: { payload: { kind: "systemEvent", toolsAllow: ["cron"] } },
      },
    });
  });

  it("caps agentTurn update toolsAllow to the creator tool surface", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-7",
        payload: { kind: "agentTurn", message: "before" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });
    await tool.execute("call-update-capped-tools", {
      action: "update",
      id: "job-7",
      job: {
        payload: {
          toolsAllow: [" exec ", " read "],
        },
      },
    });

    const params = readGatewayCall(1).params as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              toolsAllow?: string[];
            };
          };
        }
      | undefined;
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      toolsAllow: ["read"],
    });
  });

  it("keeps the creator tool surface when an agentTurn update clears toolsAllow", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-8",
        payload: { kind: "agentTurn", message: "before" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });
    await tool.execute("call-update-capped-tools-clear", {
      action: "update",
      id: "job-8",
      job: {
        payload: {
          toolsAllow: null,
        },
      },
    });

    const params = readGatewayCall(1).params as
      | {
          patch?: {
            payload?: {
              kind?: string;
              toolsAllow?: string[];
            };
          };
        }
      | undefined;
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      toolsAllow: ["read", "automations"],
      toolsAllowIsDefault: true,
    });
  });

  it("preserves legacy authority when updating an agentTurn without a policy patch", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });
    await tool.execute("call-update-capped-no-payload", {
      action: "update",
      id: "job-9",
      job: { enabled: false },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({
      method: "cron.update",
      params: {
        id: "job-9",
        patch: { enabled: false },
      },
    });
  });

  it("keeps payload metadata updates offline and preserves the stored cap", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-metadata",
        configRevision: "sha256:metadata",
        payload: {
          kind: "agentTurn",
          message: "before",
          toolsAllow: ["read", "configured__lookup"],
          toolsAllowIsDefault: true,
        },
      })
      .mockResolvedValueOnce({ ok: true });
    const resolveCreatorToolAuthority = vi.fn(async () => {
      throw new Error("metadata update must stay offline");
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      resolveCreatorToolAuthority,
    });

    await tool.execute("call-update-metadata-offline", {
      action: "update",
      id: "job-metadata",
      job: { payload: { kind: "agentTurn", message: "after" } },
    });

    expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-metadata",
        expectedConfigRevision: "sha256:metadata",
        patch: { payload: { kind: "agentTurn", message: "after" } },
      },
    });
  });

  it("intersects a visible finite update offline without opening configured MCP", async () => {
    const resolveCreatorToolAuthority = vi.fn(async () => {
      throw new Error("visible finite update must stay offline");
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read", "cron"],
      resolveCreatorToolAuthority,
    });

    await tool.execute("call-update-finite-offline", {
      action: "update",
      id: "job-finite",
      job: { payload: { kind: "agentTurn", toolsAllow: ["read"] } },
    });

    expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
    expect(readGatewayCall().params).toMatchObject({
      patch: { payload: { kind: "agentTurn", toolsAllow: ["read"] } },
    });
  });

  it("reuses one resolved snapshot across a conflicting wildcard reauthorization", async () => {
    const conflict = Object.assign(new Error("changed"), {
      name: "GatewayClientRequestError",
      details: { code: "CRON_JOB_CHANGED" },
    });
    const writeIdentities: unknown[] = [];
    const authorityScope = createCronCreatorAuthorityRunScope("run-update-race");
    const operation = new AbortController();
    const authorityGrant = mintCronCreatorAuthorityGrant(authorityScope, operation.signal);
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-resolve-race",
        configRevision: "sha256:first",
        payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
      })
      .mockImplementationOnce(async () => {
        writeIdentities.push(getGatewayToolCallerIdentity());
        throw conflict;
      })
      .mockResolvedValueOnce({
        id: "job-resolve-race",
        configRevision: "sha256:second",
        payload: { kind: "agentTurn", message: "before", toolsAllow: [] },
      })
      .mockImplementationOnce(async () => {
        const identity = getGatewayToolCallerIdentity();
        writeIdentities.push(identity);
        consumeCronCreatorAuthorityGrant(identity!.cronCreatorAuthorityGrant!);
        return { ok: true };
      });
    const resolveCreatorToolAuthority = vi.fn(async () =>
      resolvedCreatorAuthority(["read", "configured__lookup"], authorityGrant),
    );
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      resolveCreatorToolAuthority,
    });

    await tool.execute(
      "call-update-resolve-race",
      {
        action: "update",
        id: "job-resolve-race",
        job: { payload: { toolsAllow: ["*"] } },
      },
      operation.signal,
    );

    expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    expect(readGatewayCall(1).params).toMatchObject({
      patch: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read", "configured__lookup"],
          toolsAllowIsDefault: true,
        },
      },
    });
    expect(readGatewayCall(3).params).toMatchObject({
      expectedConfigRevision: "sha256:second",
      patch: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["read", "configured__lookup"],
          toolsAllowIsDefault: true,
        },
      },
    });
    expect(writeIdentities).toEqual([
      expect.objectContaining({
        cronToolsAllowCapture: "final-executable-surface",
        cronCreatorAuthorityGrant: authorityGrant,
      }),
      expect.objectContaining({
        cronToolsAllowCapture: "final-executable-surface",
        cronCreatorAuthorityGrant: authorityGrant,
      }),
    ]);
    expect(() => consumeCronCreatorAuthorityGrant(authorityGrant)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(authorityScope);
  });

  it("does not write a freshly resolved update without authenticated grant transport", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-no-caller-identity",
      configRevision: "sha256:no-caller-identity",
      payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
    });
    const tool = createTestCronTool({
      resolveCreatorToolAuthority: async () =>
        resolvedCreatorAuthority(["read", "configured__lookup"]),
    });

    await expect(
      tool.execute("call-update-no-caller-identity", {
        action: "update",
        id: "job-no-caller-identity",
        job: { payload: { toolsAllow: ["*"] } },
      }),
    ).rejects.toThrow("requires an authenticated local agent run");
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(readGatewayCall().method).toBe("cron.get");
  });

  it("fails a queued configured-MCP wildcard update visibly without writing", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-queued-authority",
      configRevision: "sha256:queued-authority",
      payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist: ["read", "cron"],
      creatorAuthorityUnavailableReason: "queued-local-operator-configured-mcp",
    });

    await expect(
      tool.execute("call-queued-configured-mcp-update", {
        action: "update",
        id: "job-queued-authority",
        job: { payload: { toolsAllow: ["*"] } },
      }),
    ).rejects.toThrow("no automation changes were saved");
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(readGatewayCall().method).toBe("cron.get");
  });

  it("rejects an unknown finite update when configured-MCP capture is incomplete", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-incomplete-authority",
      configRevision: "sha256:incomplete-authority",
      payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
      creatorToolAllowlistCaptureRef: {},
    });

    await expect(
      tool.execute("call-incomplete-authority-update", {
        action: "update",
        id: "job-incomplete-authority",
        job: { payload: { kind: "agentTurn", toolsAllow: ["future__tool"] } },
      }),
    ).rejects.toThrow("fresh authenticated direct-local operator turn");
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(readGatewayCall()).toEqual({
      method: "cron.get",
      params: { id: "job-incomplete-authority" },
    });
  });

  it("does not write an update when configured MCP authentication fails", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-auth-failure",
      configRevision: "sha256:auth-failure",
      payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
    });
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      resolveCreatorToolAuthority: async () => {
        throw new Error("Sign in to configured MCP, then retry; no automation changes were saved.");
      },
    });

    await expect(
      tool.execute("call-update-auth-failure", {
        action: "update",
        id: "job-auth-failure",
        job: { payload: { toolsAllow: ["*"] } },
      }),
    ).rejects.toThrow("no automation changes were saved");
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(readGatewayCall().method).toBe("cron.get");
  });

  it("leaves a stored narrower cap untouched when updating without a policy patch", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "exec", "cron"],
    });
    await tool.execute("call-update-preserve-existing-tools", {
      action: "update",
      id: "job-10",
      job: { enabled: false },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({
      method: "cron.update",
      params: {
        id: "job-10",
        patch: { enabled: false },
      },
    });
  });

  it("retries cap derivation after a concurrent cron job update", async () => {
    const conflict = Object.assign(
      new Error("cron job definition no longer matches the loaded version"),
      {
        name: "GatewayClientRequestError",
        details: {
          code: "CRON_JOB_CHANGED",
          expectedConfigRevision: "sha256:first",
          actualConfigRevision: "sha256:second",
        },
      },
    );
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-race",
        configRevision: "sha256:first",
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        id: "job-race",
        configRevision: "sha256:second",
        payload: { kind: "agentTurn", message: "hello", toolsAllow: [] },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      creatorToolAllowlist: ["read", "exec", "cron"],
    });
    await tool.execute("call-update-retry-cap-race", {
      action: "update",
      id: "job-race",
      job: { payload: { message: "updated" } },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(4);
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-race",
        expectedConfigRevision: "sha256:first",
        patch: { payload: { kind: "agentTurn", message: "updated" } },
      },
    });
    expect(readGatewayCall(3)).toEqual({
      method: "cron.update",
      params: {
        id: "job-race",
        expectedConfigRevision: "sha256:second",
        patch: { payload: { kind: "agentTurn", message: "updated" } },
      },
    });
  });

  it("fails closed when cron.get omits the update revision", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-no-revision",
      configRevision: null,
      payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
    });

    const tool = createTestCronTool({ creatorToolAllowlist: ["read", "cron"] });
    await expect(
      tool.execute("call-update-no-revision", {
        action: "update",
        id: "job-no-revision",
        job: { payload: { message: "updated" } },
      }),
    ).rejects.toThrow("cron.get response is missing configRevision");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing narrower toolsAllow when updating payload fields without toolsAllow", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-11",
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "exec", "cron"],
    });
    await tool.execute("call-update-preserve-existing-payload-tools", {
      action: "update",
      id: "job-11",
      job: {
        payload: { model: "openai/gpt-5.5" },
      },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-11",
        expectedConfigRevision: "sha256:test",
        patch: {
          payload: {
            kind: "agentTurn",
            model: "openai/gpt-5.5",
          },
        },
      },
    });
  });

  it("leaves a stored default cap untouched across a non-policy update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });
    await tool.execute("call-update-preserve-default-flag", {
      action: "update",
      id: "job-13",
      job: { enabled: false },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({
      method: "cron.update",
      params: {
        id: "job-13",
        patch: { enabled: false },
      },
    });
  });

  it("adds the creator tool surface when converting an existing job to agentTurn", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-12",
        payload: { kind: "systemEvent", text: "hello" },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
    });
    await tool.execute("call-update-convert-capped-agent-turn", {
      action: "update",
      id: "job-12",
      job: {
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "run later" },
      },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-12",
        expectedConfigRevision: "sha256:test",
        patch: {
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: "run later",
            toolsAllow: ["read", "automations"],
            toolsAllowIsDefault: true,
          },
        },
      },
    });
  });

  it("preserves null model payload patches on update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-clear-model", {
      action: "update",
      id: "job-9",
      job: {
        payload: {
          model: null,
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            payload?: {
              kind?: string;
              model?: string | null;
            };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-9");
    expect(params?.patch?.payload).toEqual({
      kind: "agentTurn",
      model: null,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
