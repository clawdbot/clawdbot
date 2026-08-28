import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: vi.fn(actual.loadGatewaySessionEntryReadOnly),
    loadCombinedSessionStoreForGatewayCore: vi.fn(() => ({
      agentIdBySessionKey: new Map(),
      durableTargets: [],
      storePath: "(multiple)",
      store: {},
    })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    resolveExistingUsageSessionFile: vi.fn(actual.resolveExistingUsageSessionFile),
    discoverAllSessions: vi.fn(async () => []),
    loadSessionCostSummariesFromCache: vi.fn(async () => ({
      summaries: [],
      cacheStatus: {
        status: "fresh",
        cachedFiles: 0,
        pendingFiles: 0,
        staleFiles: 0,
      },
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-ops",
      points: [],
    })),
  };
});

import {
  discoverAllSessions,
  loadSessionUsageTimeSeries,
  resolveExistingUsageSessionFile,
} from "../../infra/session-cost-usage.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  loadGatewaySessionEntryReadOnly,
} from "../session-utils.js";
import { testApi, usageHandlers } from "./usage.js";

const BASE_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

async function runSessionsUsage(params: Record<string, unknown>, config: OpenClawConfig) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["sessions.usage"],
    'usageHandlers["sessions.usage"] test invariant',
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

function mockArg(mockFn: ReturnType<typeof vi.fn>, argIndex: number): unknown {
  const call = mockFn.mock.calls[0];
  if (!call) {
    throw new Error("expected response mock call");
  }
  return call[argIndex];
}

describe("sessions.usage Session Steward boundary", () => {
  beforeEach(() => {
    testApi.sessionsUsageCache.clear();
    resetDiagnosticEventsForTest();
    vi.clearAllMocks();
  });

  it("rejects cross-agent keys before usage resolution and redacts the session tail", async () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event));
    const config: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { id: "worker" }],
      },
      session: {},
    };

    const respond = await runSessionsUsage(
      {
        ...BASE_USAGE_RANGE,
        key: "agent:main:direct:user-1",
        agentId: "worker",
      },
      config,
    );
    stop();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(mockArg(respond, 0)).toBe(false);
    expect(mockArg(respond, 2)).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'agent "worker" does not match session key agent "main"',
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("user-1");
    expect(vi.mocked(loadCombinedSessionStoreForGatewayCore)).not.toHaveBeenCalled();
    expect(vi.mocked(discoverAllSessions)).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "session_steward.boundary_decision",
      "session_steward.boundary_rejected",
    ]);
    expect(JSON.stringify(events)).not.toContain("user-1");
    expect(events[1]).toMatchObject({
      type: "session_steward.boundary_rejected",
      affectedSession: "agent:main:REDACTED",
      outcome: "reject",
    });
  });

  it.each(["agent::main", "agent:main:"])(
    "rejects malformed key %s without exposing it",
    async (key) => {
      const events: DiagnosticEventPayload[] = [];
      const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event));
      const respond = await runSessionsUsage(
        {
          ...BASE_USAGE_RANGE,
          key,
          agentId: "main",
        },
        { agents: { list: [{ id: "main" }] }, session: {} },
      );
      stop();

      expect(respond).toHaveBeenCalledTimes(1);
      expect(mockArg(respond, 0)).toBe(false);
      expect(mockArg(respond, 2)).toMatchObject({
        code: "INVALID_REQUEST",
        message: "malformed session boundary",
      });
      expect(JSON.stringify(respond.mock.calls)).not.toContain(key);
      expect(JSON.stringify(events)).not.toContain(key);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "session_steward.boundary_decision",
        affectedSession: "UNKNOWN",
        outcome: "reject",
      });
      expect(events[1]).toMatchObject({
        type: "session_steward.boundary_rejected",
        affectedSession: "UNKNOWN",
        outcome: "reject",
      });
    },
  );

  it("loads bare-key usage details through the persisted fixed-store owner", async () => {
    const config: OpenClawConfig = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        list: [{ id: "ops" }, { id: "research" }],
        defaults: { sessionStore: { agentId: "ops" } },
      },
    };
    const entry = { sessionId: "s-ops", updatedAt: 1_000 };
    vi.mocked(loadGatewaySessionEntryReadOnly).mockReturnValueOnce({
      cfg: config,
      agentId: "ops",
      canonicalKey: "global",
      entry,
      legacyKey: undefined,
      store: { global: entry },
      storeKeys: ["global"],
      storePath: "/tmp/shared-sessions.sqlite",
    });
    vi.mocked(resolveExistingUsageSessionFile).mockReturnValueOnce(
      "sqlite:ops:s-ops:/tmp/shared-sessions.sqlite",
    );

    const respond = vi.fn();
    await expectDefined(
      usageHandlers["sessions.usage.timeseries"],
      'usageHandlers["sessions.usage.timeseries"] test invariant',
    )({
      respond,
      params: { key: "global" },
      context: { getRuntimeConfig: () => config },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(vi.mocked(loadGatewaySessionEntryReadOnly)).toHaveBeenCalledWith("global", {
      agentId: "ops",
    });
    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops" }),
    );
  });
});
