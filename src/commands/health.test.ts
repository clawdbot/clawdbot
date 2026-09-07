// Health command tests cover gateway health probes, JSON output, and status formatting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import { retainGatewayResponsePayload } from "../../packages/gateway-client/src/protocol-request.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { ExitError } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildCredentialsRequiredHealthDiagnostic,
  buildRateLimitedHealthDiagnostic,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
  GATEWAY_HEALTH_REACHABLE_LINE,
} from "./gateway-health-auth-diagnostic.js";
import { formatHealthCheckFailure } from "./health-format.js";
import type { HealthSummary } from "./health.js";
import {
  formatConfigReloadHealthLine,
  formatContextEngineHealthLine,
  healthCommand,
  healthCommandNonExiting,
} from "./health.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const defaultSessions: HealthSummary["sessions"] = {
  path: "/tmp/sessions.json",
  count: 0,
  recent: [],
};

const createMainAgentSummary = (sessions = defaultSessions) => ({
  agentId: "main",
  isDefault: true,
  heartbeat: {
    enabled: true,
    every: "1m",
    everyMs: 60_000,
    prompt: "hi",
    target: "last",
    ackMaxChars: 160,
  },
  sessions,
});

const createHealthSummary = (
  params: {
    channels: HealthSummary["channels"];
    channelOrder: string[];
    channelLabels: HealthSummary["channelLabels"];
    sessions?: HealthSummary["sessions"];
  } = { channels: {}, channelOrder: [], channelLabels: {} },
): HealthSummary => {
  const sessions = params.sessions ?? defaultSessions;
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 5,
    channels: params.channels,
    channelOrder: params.channelOrder,
    channelLabels: params.channelLabels,
    heartbeatSeconds: 60,
    defaultAgentId: "main",
    agents: [createMainAgentSummary(sessions)],
    sessions,
  };
};

const callGatewayMock = vi.fn();
const listReadOnlyChannelPluginsForConfigMock = vi.fn(
  (_config: unknown, _options?: unknown): unknown[] => [],
);
const isGatewayCredentialsRequiredErrorMock = vi.fn((_value: unknown) => false);
const isGatewaySecretRefUnavailableErrorMock = vi.fn((_value: unknown) => false);
const TEST_GATEWAY_URL = "ws://127.0.0.1:18789";
const TEST_GATEWAY_MESSAGE = `Gateway mode: local\nGateway target: ${TEST_GATEWAY_URL}`;
const TEST_AUTH_CLOSE_ERROR = "gateway closed (1008):";
const TEST_TLS_FINGERPRINT = "sha256:test-health-gateway-fingerprint";
const buildGatewayConnectionDetailsMock = vi.fn(() => ({
  message: TEST_GATEWAY_MESSAGE,
  url: TEST_GATEWAY_URL,
}));
const buildGatewayProbeConnectionDetailsMock = vi.fn(() => ({
  message: TEST_GATEWAY_MESSAGE,
  preauthHandshakeTimeoutMs: 4321,
  tlsFingerprint: TEST_TLS_FINGERPRINT,
  url: TEST_GATEWAY_URL,
}));
const formatGatewayAuthErrorJsonMock = vi.fn();
const formatGatewayClientRequestErrorJsonMock = vi.fn();
const formatGatewayTransportErrorJsonMock = vi.fn();
const probeGatewayStatusMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  buildGatewayConnectionDetails: (...args: [unknown, ...unknown[]]) =>
    Reflect.apply(buildGatewayConnectionDetailsMock, undefined, args),
  buildGatewayProbeConnectionDetails: (...args: [unknown, ...unknown[]]) =>
    Reflect.apply(buildGatewayProbeConnectionDetailsMock, undefined, args),
  formatGatewayAuthErrorJson: (...args: unknown[]) => formatGatewayAuthErrorJsonMock(...args),
  formatGatewayClientRequestErrorJson: (...args: unknown[]) =>
    formatGatewayClientRequestErrorJsonMock(...args),
  formatGatewayTransportErrorJson: (...args: unknown[]) =>
    formatGatewayTransportErrorJsonMock(...args),
  isGatewayCredentialsRequiredError: (value: unknown) =>
    isGatewayCredentialsRequiredErrorMock(value),
}));

vi.mock("../gateway/credentials.js", () => ({
  isGatewaySecretRefUnavailableError: (value: unknown) =>
    isGatewaySecretRefUnavailableErrorMock(value),
}));

vi.mock("../cli/daemon-cli/probe.js", () => ({
  probeGatewayStatus: (...args: unknown[]) => probeGatewayStatusMock(...args),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: (config: unknown, options?: unknown) =>
    listReadOnlyChannelPluginsForConfigMock(config, options),
}));

function requireFirstRuntimeLog(): string {
  const [call] = runtime.log.mock.calls;
  if (!call) {
    throw new Error("expected health command log output");
  }
  const [message] = call;
  if (message === undefined) {
    throw new Error("expected health command log output");
  }
  return String(message);
}

function requireFirstGatewayRequest(): Record<string, unknown> {
  const [call] = callGatewayMock.mock.calls;
  if (!call) {
    throw new Error("expected gateway call");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected gateway request");
  }
  return request as Record<string, unknown>;
}

describe("healthCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildGatewayConnectionDetailsMock.mockReturnValue({
      message: TEST_GATEWAY_MESSAGE,
      url: TEST_GATEWAY_URL,
    });
    buildGatewayProbeConnectionDetailsMock.mockReturnValue({
      message: TEST_GATEWAY_MESSAGE,
      preauthHandshakeTimeoutMs: 4321,
      tlsFingerprint: TEST_TLS_FINGERPRINT,
      url: TEST_GATEWAY_URL,
    });
    for (const formatterMock of [
      formatGatewayAuthErrorJsonMock,
      formatGatewayClientRequestErrorJsonMock,
      formatGatewayTransportErrorJsonMock,
    ]) {
      formatterMock.mockReset();
      formatterMock.mockReturnValue(null);
    }
    isGatewayCredentialsRequiredErrorMock.mockReturnValue(false);
    isGatewaySecretRefUnavailableErrorMock.mockReturnValue(false);
    probeGatewayStatusMock.mockReset();
  });

  it("preserves plugin health in JSON while surfacing activated failures in text", async () => {
    const agentSessions = {
      path: "/tmp/sessions.json",
      count: 1,
      recent: [{ key: "+1555", updatedAt: Date.now(), age: 0 }],
    };
    const snapshot = createHealthSummary({
      channels: {
        whatsapp: { accountId: "default", linked: true, authAgeMs: 5000 },
        telegram: {
          accountId: "default",
          configured: true,
          probe: { ok: true, elapsedMs: 1 },
        },
        discord: { accountId: "default", configured: false },
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channelLabels: {
        whatsapp: "WhatsApp",
        telegram: "Telegram",
        discord: "Discord",
      },
      sessions: agentSessions,
    });
    snapshot.plugins = {
      loaded: ["calendar"],
      errors: [
        {
          id: "calendar",
          origin: "workspace",
          activated: true,
          failurePhase: "service",
          error: "service scheduler: address already in use",
        },
        {
          id: "inactive",
          origin: "workspace",
          activated: false,
          error: "inactive plugin load failed",
        },
      ],
    };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const parsed = JSON.parse(requireFirstRuntimeLog()) as HealthSummary;
    expect(parsed.durationMs).toBe(5);
    expect(parsed.channels.whatsapp?.linked).toBe(true);
    expect(parsed.channels.telegram?.configured).toBe(true);
    expect(parsed.sessions.count).toBe(1);
    expect(parsed.plugins).toEqual(snapshot.plugins);

    runtime.log.mockClear();
    callGatewayMock.mockResolvedValueOnce(snapshot);
    await healthCommand({ json: false, timeoutMs: 5000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
    expect(output).toContain(`Session store (main): ${parsed.sessions.path}`);
    expect(output).toContain(
      "Plugin calendar: failed - service scheduler: address already in use; run openclaw doctor",
    );
    expect(output).not.toContain("inactive plugin load failed");
  });

  it.each([
    { everyMs: 65_001, expected: "1m 5s 1ms" },
    { everyMs: 604_800_001, expected: "1w 1ms" },
    { everyMs: 691_200_000, expected: "1w 1d" },
  ])(
    "preserves configured duration precision in heartbeat: $everyMs ms",
    async ({ everyMs, expected }) => {
      const snapshot = createHealthSummary();
      const agent = createMainAgentSummary();
      agent.heartbeat = { ...agent.heartbeat, every: `${everyMs}ms`, everyMs };
      snapshot.agents = [agent];
      snapshot.heartbeatSeconds = Math.round(everyMs / 1_000);
      callGatewayMock.mockResolvedValueOnce(snapshot);

      await healthCommand({ json: false, timeoutMs: 1000, config: {} }, runtime);

      const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
      expect(output).toContain(`Heartbeat interval: ${expected} (main)`);
    },
  );

  it("prints the gateway probe duration in text output", async () => {
    const snapshot = createHealthSummary();
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: false, timeoutMs: 1000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
    expect(output).toContain("Gateway probe duration: 5ms");
  });

  it.each([
    { configured: true, available: false },
    { configured: undefined, available: false },
    { configured: true, available: true },
  ])(
    "keeps local diagnostic metadata separate from identity logging (configured=$configured, available=$available)",
    async ({ configured, available }) => {
      const account = {
        accountId: "default",
        enabled: true,
        configured: true,
        token: "resolved-token",
      };
      const resolveAccount = vi.fn(() => account);
      const logSelfId = vi.fn();
      listReadOnlyChannelPluginsForConfigMock.mockReturnValueOnce([
        {
          id: "diagnostic-fixture",
          meta: { label: "Diagnostic" },
          config: {
            listAccountIds: () => ["default"],
            inspectAccount: () => ({
              accountId: "default",
              enabled: true,
              configured,
              tokenSource: "secretref",
              tokenStatus: available ? "available" : "configured_unavailable",
            }),
            resolveAccount,
          },
          status: { logSelfId },
        },
      ]);
      callGatewayMock.mockResolvedValueOnce(
        createHealthSummary({
          channels: { "diagnostic-fixture": { accountId: "default", configured, linked: true } },
          channelOrder: ["diagnostic-fixture"],
          channelLabels: { "diagnostic-fixture": "Diagnostic" },
        }),
      );

      await healthCommand({ config: { diagnostics: { flags: ["health"] } } }, runtime as never);

      const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
      expect(output).toContain(`configured=${configured ?? "unknown"} tokenSource=secretref`);
      if (available) {
        expect(logSelfId).toHaveBeenCalledWith(expect.objectContaining({ account }));
      } else {
        expect(logSelfId).not.toHaveBeenCalled();
        expect(resolveAccount).not.toHaveBeenCalled();
      }
    },
  );

  it("surfaces unhealthy secondary accounts without an explicit account binding", async () => {
    const primary = {
      accountId: "main",
      enabled: true,
      configured: true,
      linked: true,
      healthState: "healthy",
      probe: { ok: true, elapsedMs: 12 },
    };
    const snapshot = createHealthSummary({
      channels: {
        matrix: {
          ...primary,
          accounts: {
            main: primary,
            alerts: {
              accountId: "alerts",
              enabled: true,
              configured: true,
              linked: true,
              healthState: "blocked",
            },
          },
        },
      },
      channelOrder: ["matrix"],
      channelLabels: { matrix: "Matrix" },
    });
    callGatewayMock.mockResolvedValueOnce(snapshot);
    listReadOnlyChannelPluginsForConfigMock.mockReturnValueOnce([
      { id: "matrix", config: { listAccountIds: () => ["main", "alerts"] } },
    ]);

    await healthCommand({ json: false, timeoutMs: 1000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
    expect(output).toContain("Matrix: blocked");
    expect(output).not.toContain("Matrix: ok");
  });

  it.each(["remote", "empty", "missing"] as const)(
    "shows each explicit fleet owner's sessions with %s agent summaries",
    async (agentSummaries) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const storePath = state.statePath("shared.sqlite");
        const updatedAt = Date.now();
        for (const [agentId, key] of [
          ["alpha", "first"],
          ["alpha", "second"],
          ["beta", "only"],
        ] as const) {
          await replaceSessionEntry(
            { agentId, storePath, sessionKey: `agent:${agentId}:${key}` },
            { sessionId: `${agentId}-${key}`, updatedAt },
          );
        }
        const agent = (agentId: string, keys: string[]) => ({
          ...createMainAgentSummary({
            path: storePath,
            count: keys.length,
            recent: keys.map((key) => ({
              key: `agent:${agentId}:${key}`,
              updatedAt,
              age: 0,
            })),
          }),
          agentId,
          isDefault: false,
        });
        const { agents: _agents, ...snapshot } = createHealthSummary();
        callGatewayMock.mockResolvedValueOnce({
          ...snapshot,
          defaultAgentId: undefined,
          ...(agentSummaries === "missing"
            ? {}
            : {
                agents:
                  agentSummaries === "empty"
                    ? []
                    : [agent("alpha", ["first", "second"]), agent("beta", ["only"])],
              }),
        });

        await healthCommand(
          {
            json: false,
            timeoutMs: 1_000,
            config: {
              session: { store: storePath },
              agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
            },
          },
          runtime as never,
        );

        const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
        expect(output).toContain(
          `Session store (alpha): ${storePath} (2 entries)\n- agent:alpha:first`,
        );
        expect(output).toContain(
          `Session store (beta): ${storePath} (1 entries)\n- agent:beta:only`,
        );
        expect(output).not.toContain("(default)");
      });
    },
  );

  it("prints persistent event-loop degradation duration in text output", async () => {
    const snapshot = {
      ...createHealthSummary(),
      eventLoop: {
        degraded: true,
        degradedSinceMs: 180_000,
        reasons: ["event_loop_delay" as const],
        intervalMs: 30_000,
        delayP99Ms: 1_200,
        delayMaxMs: 1_500,
        utilization: 0.75,
        cpuCoreRatio: 0.5,
      },
    };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: false, timeoutMs: 1000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
    expect(output).toContain("Gateway event loop: degraded for 3m");
    expect(output).toContain("p99=1200ms");
  });

  it("omits the probe duration for legacy gateway snapshots", async () => {
    const { durationMs, ...legacySnapshot } = createHealthSummary();
    expect(durationMs).toBe(5);
    callGatewayMock.mockResolvedValueOnce(legacySnapshot);

    await healthCommand({ json: false, timeoutMs: 1000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((call) => String(call[0])).join("\n"));
    expect(output).not.toContain("Gateway probe duration:");
  });

  it("prints the delivery queue warning line when the gateway reports dead-letters", async () => {
    const snapshot = createHealthSummary();
    snapshot.deliveryQueues = {
      failed: [{ queueName: "outbound", count: 2, oldestFailedAt: Date.now() - 7_200_000 }],
    };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: false, timeoutMs: 1000, config: {} }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const output = stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(output).toContain(
      "Delivery queue: warning (dead-lettered entries — outbound: 2; oldest 2h ago)",
    );
  });

  it("surfaces a disabled config hot-reload watcher in JSON output", async () => {
    const snapshot = createHealthSummary();
    snapshot.configReload = { hotReloadStatus: "disabled" };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    const parsed = JSON.parse(requireFirstRuntimeLog()) as HealthSummary;
    expect(parsed.configReload).toEqual({ hotReloadStatus: "disabled" });
  });

  it("prints the config hot-reload disabled line in text output", async () => {
    const snapshot = createHealthSummary();
    snapshot.configReload = { hotReloadStatus: "disabled" };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: false, timeoutMs: 5000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(output).toContain("Config hot reload: disabled");
  });

  it("omits the config hot-reload line in text output when the reloader is active", async () => {
    const snapshot = createHealthSummary();
    snapshot.configReload = { hotReloadStatus: "active" };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: false, timeoutMs: 5000, config: {} }, runtime as never);

    const output = stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(output).not.toContain("Config hot reload");
  });

  it.each(
    [0, -600_000, 600_000].flatMap((clockSkewMs) =>
      ["agent", "top-level"].map((surface) => ({ clockSkewMs, surface })),
    ),
  )(
    "prints $surface gateway ages with $clockSkewMs ms client clock skew",
    async ({ clockSkewMs, surface }) => {
      const gatewayNow = Date.now();
      const recent = [
        { key: "main", updatedAt: gatewayNow - 60_000, age: 60_000 },
        { key: "fresh", updatedAt: gatewayNow, age: 0 },
        { key: "foo", updatedAt: null, age: null },
      ];
      const snapshot = createHealthSummary({
        channels: {
          whatsapp: { accountId: "default", linked: true, authAgeMs: 5 * 60_000 },
          telegram: {
            accountId: "default",
            configured: true,
            probe: {
              ok: true,
              elapsedMs: 7,
              bot: { username: "bot" },
              webhook: { url: "https://example.com/h" },
            },
          },
          discord: { accountId: "default", configured: false },
        },
        channelOrder: ["whatsapp", "telegram", "discord"],
        channelLabels: {
          whatsapp: "WhatsApp",
          telegram: "Telegram",
          discord: "Discord",
        },
        sessions: {
          path: "/tmp/sessions.json",
          count: recent.length,
          recent,
        },
      });
      if (surface === "top-level") {
        snapshot.agents = [];
      }
      callGatewayMock.mockResolvedValueOnce(snapshot);
      const clock = vi.spyOn(Date, "now").mockReturnValue(gatewayNow + clockSkewMs);
      try {
        await healthCommand(
          {
            json: false,
            verbose: true,
            timeoutMs: 1000,
            config: { agents: { ownership: "explicit", entries: {} } },
          },
          runtime as never,
        );
      } finally {
        clock.mockRestore();
      }

      expect(runtime.exit).not.toHaveBeenCalled();
      const output = stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"));
      expect(output).toContain("- main (1m ago)\n- fresh (0m ago)\n- foo (no activity)");
      expect(output).toMatch(/WhatsApp: linked/i);
      expect(runtime.log.mock.calls.slice(0, 3)).toEqual([
        ["Gateway connection:"],
        ["  Gateway mode: local"],
        [`  Gateway target: ${TEST_GATEWAY_URL}`],
      ]);
      expect(buildGatewayConnectionDetailsMock).toHaveBeenCalled();
    },
  );

  it("passes explicit gateway credentials through to the gateway call", async () => {
    const snapshot = createHealthSummary();
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand(
      {
        json: true,
        timeoutMs: 5000,
        config: {},
        token: "setup-token",
        password: "setup-password",
        ignoreEnvUrlOverride: true,
      },
      runtime as never,
    );

    expect(callGatewayMock).toHaveBeenCalledOnce();
    const gatewayRequest = requireFirstGatewayRequest();
    expect(gatewayRequest.method).toBe("health");
    expect(gatewayRequest.token).toBe("setup-token");
    expect(gatewayRequest.password).toBe("setup-password");
    expect(gatewayRequest.ignoreEnvUrlOverride).toBe(true);
    expect(gatewayRequest.sharedStateMode).toBe("read-only");
  });

  it("outputs JSON for gateway transport failures in JSON mode", async () => {
    const error = new Error("gateway closed (1006)");
    const payload = {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1006)",
        code: 1006,
        reason: "no close reason",
      },
      gateway: {
        url: TEST_GATEWAY_URL,
        urlSource: "local loopback",
        bindDetail: "Bind: loopback",
      },
    };
    callGatewayMock.mockRejectedValueOnce(error);
    formatGatewayTransportErrorJsonMock.mockReturnValueOnce(payload);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    expect(formatGatewayTransportErrorJsonMock).toHaveBeenCalledWith(error);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(requireFirstRuntimeLog())).toEqual(payload);
  });

  it("keeps Gateway health request failures machine-readable in JSON mode", async () => {
    const error = new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "health snapshot unavailable",
      details: { operation: "refresh" },
      retryable: true,
      retryAfterMs: 250,
    });
    const payload = {
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "UNAVAILABLE",
        message: "health snapshot unavailable",
        details: { operation: "refresh" },
        retryable: true,
        retryAfterMs: 250,
      },
    };
    callGatewayMock.mockRejectedValueOnce(error);
    formatGatewayClientRequestErrorJsonMock.mockReturnValueOnce(payload);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    expect(formatGatewayAuthErrorJsonMock).toHaveBeenCalledWith(error);
    expect(formatGatewayClientRequestErrorJsonMock).toHaveBeenCalledWith(error);
    expect(formatGatewayTransportErrorJsonMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(requireFirstRuntimeLog())).toEqual(payload);
  });

  it("preserves Gateway health request failures in human-readable mode", async () => {
    const error = new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "health snapshot unavailable",
      retryable: true,
    });
    callGatewayMock.mockRejectedValueOnce(error);

    await expect(
      healthCommand({ json: false, timeoutMs: 5000, config: {} }, runtime as never),
    ).rejects.toBe(error);

    expect(formatGatewayAuthErrorJsonMock).not.toHaveBeenCalled();
    expect(formatGatewayClientRequestErrorJsonMock).not.toHaveBeenCalled();
    expect(formatGatewayTransportErrorJsonMock).not.toHaveBeenCalled();
  });

  it.each([
    { json: true, expectedLogs: 1 },
    { json: undefined, expectedLogs: 2 },
  ])(
    "reports reachable gateway diagnostics when health RPC credentials are missing",
    async ({ json, expectedLogs }) => {
      callGatewayMock.mockRejectedValueOnce(new Error());
      isGatewayCredentialsRequiredErrorMock.mockReturnValueOnce(true);
      probeGatewayStatusMock.mockResolvedValueOnce({
        ok: false,
        kind: "connect",
        error: TEST_AUTH_CLOSE_ERROR,
        gatewayReached: true,
      });

      await healthCommand({ json, timeoutMs: 5000, config: {} }, runtime as never);

      expect(probeGatewayStatusMock).toHaveBeenCalledWith({
        url: TEST_GATEWAY_URL,
        token: undefined,
        password: undefined,
        tlsFingerprint: TEST_TLS_FINGERPRINT,
        preauthHandshakeTimeoutMs: 4321,
        timeoutMs: 5000,
        config: {},
        json,
      });
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).toHaveBeenCalledTimes(expectedLogs);
      if (json) {
        expect(JSON.parse(requireFirstRuntimeLog())).toEqual(
          buildCredentialsRequiredHealthDiagnostic(),
        );
      } else {
        expect(runtime.log.mock.calls).toEqual([
          [GATEWAY_HEALTH_REACHABLE_LINE],
          [GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE],
        ]);
      }
    },
  );

  it.each([
    { json: true, expectedLogs: 1 },
    { json: undefined, expectedLogs: 2 },
  ])(
    "preserves a typed pre-hello authentication lockout through health output",
    async ({ json, expectedLogs }) => {
      const error = new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unauthorized: too many failed authentication attempts (retry later)",
        details: {
          code: "AUTH_RATE_LIMITED",
          authReason: "rate_limited",
          recommendedNextStep: "wait_then_retry",
        },
        retryable: true,
        retryAfterMs: 60_000,
      });
      retainGatewayResponsePayload(error, undefined);
      callGatewayMock.mockRejectedValueOnce(error);

      await healthCommand({ json, timeoutMs: 5000, config: {} }, runtime as never);

      expect(isGatewayCredentialsRequiredErrorMock).not.toHaveBeenCalled();
      expect(probeGatewayStatusMock).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).toHaveBeenCalledTimes(expectedLogs);
      if (json) {
        expect(JSON.parse(requireFirstRuntimeLog())).toEqual(
          buildRateLimitedHealthDiagnostic(error),
        );
      } else {
        expect(runtime.log.mock.calls).toEqual([
          [GATEWAY_HEALTH_REACHABLE_LINE],
          [GATEWAY_HEALTH_RATE_LIMITED_MESSAGE],
        ]);
      }
    },
  );

  it.each([
    { json: true, expectedLogs: 1 },
    { json: undefined, expectedLogs: 2 },
  ])(
    "reports temporary authentication lockouts without credential-change guidance",
    async ({ json, expectedLogs }) => {
      callGatewayMock.mockRejectedValueOnce(new Error());
      isGatewayCredentialsRequiredErrorMock.mockReturnValueOnce(true);
      probeGatewayStatusMock.mockResolvedValueOnce({
        ok: false,
        kind: "connect",
        error: "connect failed",
        connectFailure: { kind: "rate-limited", detailCode: "AUTH_RATE_LIMITED" },
        gatewayReached: true,
      });

      await healthCommand({ json, timeoutMs: 5000, config: {} }, runtime as never);

      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).toHaveBeenCalledTimes(expectedLogs);
      if (json) {
        expect(JSON.parse(requireFirstRuntimeLog())).toEqual(buildRateLimitedHealthDiagnostic());
      } else {
        expect(runtime.log.mock.calls).toEqual([
          [GATEWAY_HEALTH_REACHABLE_LINE],
          [GATEWAY_HEALTH_RATE_LIMITED_MESSAGE],
        ]);
      }
      const output = runtime.log.mock.calls.flat().join("\n");
      expect(output).not.toContain("gateway.remote.token");
      expect(output).not.toContain("devices rotate");
    },
  );

  it("does not report reachable from a locally constructed rate-limit error", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "unauthorized: too many failed authentication attempts (retry later)",
      details: { code: "AUTH_RATE_LIMITED" },
    });
    callGatewayMock.mockRejectedValueOnce(error);

    await expect(healthCommand({ config: {} }, runtime as never)).rejects.toBe(error);

    expect(runtime.log).not.toHaveBeenCalled();
    expect(probeGatewayStatusMock).not.toHaveBeenCalled();
  });

  it("keeps credential failures machine-readable when the gateway is unreachable", async () => {
    const error = new Error("gateway health requires credentials");
    const payload = {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: "gateway health requires credentials",
      },
    };
    callGatewayMock.mockRejectedValueOnce(error);
    isGatewayCredentialsRequiredErrorMock.mockReturnValue(true);
    probeGatewayStatusMock.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: "connect ECONNREFUSED 127.0.0.1:18789",
    });
    formatGatewayAuthErrorJsonMock.mockReturnValueOnce(payload);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    expect(formatGatewayAuthErrorJsonMock).toHaveBeenCalledWith(error);
    expect(formatGatewayTransportErrorJsonMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(requireFirstRuntimeLog())).toEqual(payload);
  });

  it("keeps explicit URL auth failures machine-readable", async () => {
    const error = new Error("gateway url override requires explicit credentials");
    const payload = {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: "gateway url override requires explicit credentials",
      },
    };
    callGatewayMock.mockRejectedValueOnce(error);
    formatGatewayAuthErrorJsonMock.mockReturnValueOnce(payload);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime as never);

    expect(probeGatewayStatusMock).not.toHaveBeenCalled();
    expect(formatGatewayAuthErrorJsonMock).toHaveBeenCalledWith(error);
    expect(formatGatewayTransportErrorJsonMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(requireFirstRuntimeLog())).toEqual(payload);
  });

  it("reports reachable gateway diagnostics when configured auth SecretRefs are unavailable", async () => {
    const error = new Error("gateway.auth.password is unavailable");
    callGatewayMock.mockRejectedValueOnce(error);
    isGatewaySecretRefUnavailableErrorMock.mockReturnValueOnce(true);
    probeGatewayStatusMock.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
      gatewayReached: true,
    });

    await healthCommand(
      { json: false, timeoutMs: 5000, config: {}, ignoreEnvUrlOverride: true },
      runtime as never,
    );

    expect(isGatewaySecretRefUnavailableErrorMock).toHaveBeenCalledWith(error);
    expect(buildGatewayProbeConnectionDetailsMock).toHaveBeenCalledWith({
      config: {},
      token: undefined,
      password: undefined,
      ignoreEnvUrlOverride: true,
      localPortOverride: undefined,
    });
    expect(probeGatewayStatusMock).toHaveBeenCalledWith({
      url: TEST_GATEWAY_URL,
      token: undefined,
      password: undefined,
      tlsFingerprint: TEST_TLS_FINGERPRINT,
      preauthHandshakeTimeoutMs: 4321,
      timeoutMs: 5000,
      config: {},
      json: false,
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log.mock.calls).toEqual([
      [GATEWAY_HEALTH_REACHABLE_LINE],
      [GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE],
    ]);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("throws ExitError from healthCommandNonExiting instead of exiting the host runtime", async () => {
    const error = new Error("gateway.auth.password is unavailable");
    callGatewayMock.mockRejectedValueOnce(error);
    isGatewaySecretRefUnavailableErrorMock.mockReturnValueOnce(true);
    probeGatewayStatusMock.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
      gatewayReached: true,
    });

    await expect(
      healthCommandNonExiting(
        { json: false, timeoutMs: 5000, config: {}, ignoreEnvUrlOverride: true },
        runtime as never,
      ),
    ).rejects.toBeInstanceOf(ExitError);

    // The embedded wizard/doctor host keeps running: its own exit is never invoked
    // and the diagnostic was still printed through its log sink.
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls).toEqual([
      [GATEWAY_HEALTH_REACHABLE_LINE],
      [GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE],
    ]);
  });
});

describe("formatContextEngineHealthLine", () => {
  it("summarizes quarantined context engines", () => {
    const summary = createHealthSummary();
    summary.contextEngines = {
      quarantined: [
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "assemble",
          reason: "db corrupt",
          failedAt: 123,
        },
      ],
    };

    expect(formatContextEngineHealthLine(summary)).toBe(
      "Context engine: warning (1 quarantined; downgraded to legacy: lossless-claw)",
    );
  });
});

describe("formatConfigReloadHealthLine", () => {
  it("reports a disabled config hot-reload watcher", () => {
    const summary = createHealthSummary();
    summary.configReload = { hotReloadStatus: "disabled" };

    expect(formatConfigReloadHealthLine(summary)).toBe(
      "Config hot reload: disabled (watcher retries exhausted; restart the gateway to restore it)",
    );
  });

  it("stays silent while the config hot-reload watcher is active", () => {
    const summary = createHealthSummary();
    summary.configReload = { hotReloadStatus: "active" };

    expect(formatConfigReloadHealthLine(summary)).toBeNull();
  });

  it("stays silent when no config reloader is running", () => {
    const summary = createHealthSummary();

    expect(formatConfigReloadHealthLine(summary)).toBeNull();
  });
});

describe("formatHealthCheckFailure", () => {
  it("keeps non-rich output stable", () => {
    const err = new Error("gateway closed (1006 abnormal closure): no close reason");
    expect(formatHealthCheckFailure(err, { rich: false })).toBe(
      `Health check failed: ${String(err)}`,
    );
  });

  it("formats gateway connection details as indented key/value lines", () => {
    const err = new Error(
      [
        "gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "Gateway target: ws://127.0.0.1:19001",
        "Source: local loopback",
        "Config: /Users/steipete/.openclaw-dev/openclaw.json",
        "Bind: loopback",
      ].join("\n"),
    );

    expect(stripAnsi(formatHealthCheckFailure(err, { rich: true }))).toBe(
      [
        "Health check failed: gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "  Gateway target: ws://127.0.0.1:19001",
        "  Source: local loopback",
        "  Config: /Users/steipete/.openclaw-dev/openclaw.json",
        "  Bind: loopback",
      ].join("\n"),
    );
  });
});
