import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: {
      list: [{ id: "main", default: true }, { id: "opus" }],
    },
    session: {},
  })),
}));

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
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "opus") {
        return [
          {
            sessionId: "s-opus",
            sessionFile: "/tmp/agents/opus/sessions/s-opus.jsonl",
            mtime: 200,
            firstUserMessage: "hi",
          },
        ];
      }
      return [];
    }),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-opus",
      points: [],
    })),
    loadSessionLogs: vi.fn(async () => []),
  };
});

import { loadSessionLogs, loadSessionUsageTimeSeries } from "../../infra/session-cost-usage.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { usageHandlers } from "./usage.js";
import {
  TEST_RUNTIME_CONFIG,
  getUsageMockArg,
  mockStoredUsageSession,
  withUsageTestState,
} from "./usage.sessions-usage.test-support.js";

async function runSessionsUsageDetail(
  method: "sessions.usage.timeseries" | "sessions.usage.logs",
  params: Record<string, unknown>,
  config: OpenClawConfig = TEST_RUNTIME_CONFIG,
) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers[method],
    `usageHandlers["${method}"] test invariant`,
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)[typeof method]>[0]);
  return respond;
}

describe("sessions.usage details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a canonical SQLite target into sessions.usage.timeseries", async () => {
    mockStoredUsageSession("agent:opus:s-opus", "s-opus");
    await runSessionsUsageDetail("sessions.usage.timeseries", {
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "opus", sessionFile: expect.stringMatching(/^sqlite:/) }),
    );
  });

  it("passes a canonical SQLite target into sessions.usage.logs", async () => {
    mockStoredUsageSession("agent:opus:s-opus", "s-opus");
    await runSessionsUsageDetail("sessions.usage.logs", { key: "agent:opus:s-opus" });

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "opus", sessionFile: expect.stringMatching(/^sqlite:/) }),
    );
  });

  it("loads bare-key usage details through the persisted fixed-store owner", async () => {
    const config: OpenClawConfig = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        list: [{ id: "ops" }, { id: "research" }],
        defaults: { sessionStore: { agentId: "ops" } },
      },
    };
    mockStoredUsageSession("global", "s-ops", {
      agentId: "ops",
      config,
      storePath: "/tmp/shared-sessions.sqlite",
    });

    const respond = await runSessionsUsageDetail(
      "sessions.usage.timeseries",
      { key: "global" },
      config,
    );

    expect(getUsageMockArg(respond, 0, 0)).toBe(true);
    expect(vi.mocked(loadGatewaySessionEntryReadOnly)).toHaveBeenCalledWith("global", {
      agentId: "ops",
    });
    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it("preserves JSONL detail lookup for storeless sessions", async () => {
    await withUsageTestState(async (writeSessionFile) => {
      const sessionFile = writeSessionFile("storeless.jsonl");
      const canonicalSessionFile = fs.realpathSync(sessionFile);
      await runSessionsUsageDetail("sessions.usage.timeseries", {
        key: "agent:opus:storeless",
      });
      expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
        expect.objectContaining({ sessionFile: canonicalSessionFile, sessionEntry: undefined }),
      );
    });
  });

  it("fails closed when a canonical stored target no longer matches", async () => {
    const key = "agent:opus:stale";
    mockStoredUsageSession(key, "stale", { resolution: "missing" });
    const respond = await runSessionsUsageDetail("sessions.usage.timeseries", { key });
    expect(getUsageMockArg(respond, 0, 0)).toBe(false);
    expect(vi.mocked(loadSessionUsageTimeSeries)).not.toHaveBeenCalled();
  });

  it("rejects traversal-style keys in timeseries/log lookups", async () => {
    const params = { key: "agent:opus:../../etc/passwd" };
    const timeseriesRespond = await runSessionsUsageDetail("sessions.usage.timeseries", params);
    const logsRespond = await runSessionsUsageDetail("sessions.usage.logs", params);

    for (const respond of [timeseriesRespond, logsRespond]) {
      expect(respond.mock.calls).toEqual([
        [
          false,
          undefined,
          {
            code: "INVALID_REQUEST",
            message: "Invalid session key: agent:opus:../../etc/passwd",
          },
        ],
      ]);
    }
  });
});
