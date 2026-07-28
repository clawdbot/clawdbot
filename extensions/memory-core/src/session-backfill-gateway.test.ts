import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionBackfillGatewayMethods } from "./session-backfill-gateway.js";
import { executeSessionBackfill, executeSessionBackfillBatch } from "./session-backfill.js";

vi.mock("./session-backfill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-backfill.js")>()),
  executeSessionBackfill: vi.fn(),
  executeSessionBackfillBatch: vi.fn(),
}));

type RegisteredMethod = {
  handler: (options: GatewayRequestHandlerOptions) => Promise<void>;
  scope: string | undefined;
};

const executeMock = vi.mocked(executeSessionBackfill);
const executeBatchMock = vi.mocked(executeSessionBackfillBatch);
const SESSION_BACKFILL_GATEWAY_METHODS = {
  preview: "memory.sessionBackfill.preview",
  apply: "memory.sessionBackfill.apply",
  rollback: "memory.sessionBackfill.rollback",
} as const;

function createHarness(config?: Record<string, unknown>) {
  const methods = new Map<string, RegisteredMethod>();
  const runtimeConfig =
    config !== undefined
      ? config
      : {
          agents: {
            list: [{ id: "main", default: true, workspace: "/tmp/main-workspace" }],
          },
        };
  const api = {
    runtime: {
      config: { current: () => runtimeConfig },
      agent: {
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/main-workspace"),
      },
    },
    registerGatewayMethod(
      method: string,
      handler: RegisteredMethod["handler"],
      options?: { scope?: string },
    ) {
      methods.set(method, { handler, scope: options?.scope });
    },
  } as unknown as OpenClawPluginApi;
  registerSessionBackfillGatewayMethods(api);
  return { api, methods };
}

async function invoke(method: RegisteredMethod, params: unknown) {
  const respond = vi.fn();
  await method.handler({ params, respond } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

describe("session backfill gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers read preview and admin mutation methods", () => {
    const { methods } = createHarness();
    expect([...methods.entries()].map(([name, value]) => [name, value.scope])).toEqual([
      [SESSION_BACKFILL_GATEWAY_METHODS.preview, "operator.read"],
      [SESSION_BACKFILL_GATEWAY_METHODS.apply, "operator.admin"],
      [SESSION_BACKFILL_GATEWAY_METHODS.rollback, "operator.admin"],
    ]);
  });

  it("validates preview params and returns at most three samples per day", async () => {
    const { methods } = createHarness();
    executeBatchMock.mockResolvedValueOnce({
      result: {
        agentId: "main",
        workspaceDir: "/tmp/main-workspace",
        applied: false,
        rem: false,
        days: [
          {
            day: "2026-07-01",
            candidateCount: 4,
            topCandidates: ["one", "two", "three", "four"],
          },
        ],
        candidateCount: 4,
        stagedEntries: 0,
        writtenDiaryEntries: 0,
        replacedDiaryEntries: 0,
      },
      continuation: { advanced: false, hasMore: true },
    });
    const preview = methods.get(SESSION_BACKFILL_GATEWAY_METHODS.preview)!;
    const respond = await invoke(preview, {
      agentId: "main",
      from: "2026-07-01",
      to: "2026-07-31",
      limitDays: 14,
    });

    expect(executeBatchMock).toHaveBeenCalledWith({
      agentId: "main",
      from: "2026-07-01",
      to: "2026-07-31",
      limitDays: 14,
      workspaceDir: "/tmp/main-workspace",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      days: 1,
      candidates: 4,
      perDay: [{ day: "2026-07-01", candidateCount: 4, sample: ["one", "two", "three"] }],
      staged: 0,
      truncated: true,
    });
  });

  it("rejects invalid ranges and unknown params before executing", async () => {
    const { methods } = createHarness();
    const preview = methods.get(SESSION_BACKFILL_GATEWAY_METHODS.preview)!;
    const invalidRange = await invoke(preview, {
      agentId: "main",
      from: "2026-08-01",
      to: "2026-07-01",
    });
    const unexpected = await invoke(preview, { agentId: "main", archiveFiles: [] });

    expect(executeMock).not.toHaveBeenCalled();
    expect(invalidRange.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "from must not be after to.",
    });
    expect(unexpected.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "unexpected parameter: archiveFiles",
    });
  });

  it("rejects unknown agents as invalid requests", async () => {
    const { methods } = createHarness();
    const respond = await invoke(methods.get(SESSION_BACKFILL_GATEWAY_METHODS.preview)!, {
      agentId: "missing",
    });

    expect(executeMock).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'Unknown agent id "missing".',
    });
  });

  it("allows only the implicit default agent when no roster is configured", async () => {
    const { methods } = createHarness({});
    const preview = methods.get(SESSION_BACKFILL_GATEWAY_METHODS.preview)!;
    const missing = await invoke(preview, { agentId: "missing" });

    expect(missing.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'Unknown agent id "missing".',
    });
  });

  it("applies a chunk with cursor progress and rolls back by agent", async () => {
    const { methods } = createHarness();
    executeBatchMock.mockResolvedValueOnce({
      result: {
        agentId: "main",
        workspaceDir: "/tmp/main-workspace",
        applied: true,
        rem: false,
        days: [{ day: "2026-07-01", candidateCount: 2, topCandidates: ["one", "two"] }],
        candidateCount: 2,
        stagedEntries: 1,
        writtenDiaryEntries: 1,
        replacedDiaryEntries: 0,
      },
      continuation: { advanced: true, hasMore: false },
    });
    executeMock.mockResolvedValueOnce({
      agentId: "main",
      workspaceDir: "/tmp/main-workspace",
      applied: false,
      rem: false,
      days: [],
      candidateCount: 0,
      stagedEntries: 0,
      writtenDiaryEntries: 0,
      replacedDiaryEntries: 0,
      rollback: { removedDiaryEntries: 3, removedStagedEntries: 2 },
    });

    const applyRespond = await invoke(methods.get(SESSION_BACKFILL_GATEWAY_METHODS.apply)!, {
      agentId: "main",
      limitDays: 14,
    });
    expect(applyRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        days: 1,
        candidates: 2,
        staged: 1,
        cursor: { advanced: true, exhausted: false, hasMore: false },
      }),
    );
    const rollbackRespond = await invoke(methods.get(SESSION_BACKFILL_GATEWAY_METHODS.rollback)!, {
      agentId: "main",
    });
    expect(rollbackRespond).toHaveBeenCalledWith(true, {
      removedDiaryEntries: 3,
      removedStagedEntries: 2,
    });
  });
});
