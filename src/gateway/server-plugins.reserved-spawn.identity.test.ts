import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { RESERVED_SUBAGENT_IDENTITY_MAX_BYTES } from "./server-plugins-reserved-spawn.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn());
const hasSubagentRunIdentity = vi.hoisted(() => vi.fn());
const getLatestSubagentRunByChildSessionKey = vi.hoisted(() => vi.fn());
const loadSessionEntryReadOnly = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
}));
vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
}));
vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext,
  onAgentEvent: vi.fn(),
}));
vi.mock("./session-utils-store.js", () => ({
  loadSessionEntryReadOnly,
}));

import { createGatewaySubagentRuntime } from "./server-plugins.js";

const reservation = {
  requesterSessionKey: "agent:main:main",
  targetAgentId: "worker",
  childSessionKey: "agent:worker:subagent:plugin-reserved-child",
  runId: "plugin-reserved-run",
  task: "run the reserved child",
} as const;

function withReservedPluginScope<T>(run: () => T): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: { dedupe: new Map() } as GatewayRequestContext,
      isWebchatConnect: () => false,
    },
    () => withPluginRuntimePluginIdScope("agentic-os", run),
  );
}

describe("spawnReserved identity byte bounds", () => {
  beforeEach(() => {
    spawnSubagentDirect.mockReset();
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    hasSubagentRunIdentity.mockReset().mockReturnValue(false);
    getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
    loadSessionEntryReadOnly.mockReset().mockReturnValue({
      cfg: {
        agents: {
          defaults: { subagents: { allowAgents: ["worker"] } },
          entries: { main: {}, worker: {} },
        },
      },
      entry: {
        pluginOwnerId: "agentic-os",
        sessionId: "requester-session",
        lifecycleRevision: "1",
        createdAt: 1,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts exact-limit identities and rejects raw UTF-8 overflow before persistence", async () => {
    const childPrefix = "agent:worker:subagent:";
    const exactLimitChildSessionKey = `${childPrefix}${"c".repeat(
      RESERVED_SUBAGENT_IDENTITY_MAX_BYTES - Buffer.byteLength(childPrefix, "utf8"),
    )}`;
    const exactLimitRunId = "r".repeat(RESERVED_SUBAGENT_IDENTITY_MAX_BYTES);
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: exactLimitChildSessionKey,
      runId: exactLimitRunId,
      mode: "run",
    });

    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          childSessionKey: exactLimitChildSessionKey,
          runId: exactLimitRunId,
        }),
      ),
    ).resolves.toMatchObject({
      childSessionKey: exactLimitChildSessionKey,
      runId: exactLimitRunId,
    });

    loadSessionEntryReadOnly.mockClear();
    getAgentRunContext.mockClear();
    hasSubagentRunIdentity.mockClear();
    getLatestSubagentRunByChildSessionKey.mockClear();
    const multibyteChildSessionKey = `${childPrefix}${"€".repeat(
      Math.floor(
        (RESERVED_SUBAGENT_IDENTITY_MAX_BYTES - Buffer.byteLength(childPrefix, "utf8")) /
          Buffer.byteLength("€", "utf8"),
      ),
    )}€`;
    expect(Buffer.byteLength(multibyteChildSessionKey, "utf8")).toBeGreaterThan(
      RESERVED_SUBAGENT_IDENTITY_MAX_BYTES,
    );
    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          childSessionKey: multibyteChildSessionKey,
          runId: "plugin-reserved-run-identity-utf8",
        }),
      ),
    ).rejects.toThrow(`${RESERVED_SUBAGENT_IDENTITY_MAX_BYTES} byte limit`);

    const rawWhitespaceOverLimitRunId = `${" ".repeat(RESERVED_SUBAGENT_IDENTITY_MAX_BYTES)}x`;
    await expect(
      withReservedPluginScope(() =>
        createGatewaySubagentRuntime().spawnReserved({
          ...reservation,
          childSessionKey: "agent:worker:subagent:plugin-reserved-child-identity-raw",
          runId: rawWhitespaceOverLimitRunId,
        }),
      ),
    ).rejects.toThrow(`${RESERVED_SUBAGENT_IDENTITY_MAX_BYTES} byte limit`);

    expect(loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(getAgentRunContext).not.toHaveBeenCalled();
    expect(hasSubagentRunIdentity).not.toHaveBeenCalled();
    expect(getLatestSubagentRunByChildSessionKey).not.toHaveBeenCalled();
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
  });
});
