import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsDiagnoseResult } from "../../packages/gateway-protocol/src/index.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sessionsDiagnoseCommand } from "./sessions-diagnose.js";

const callGatewayMock = vi.fn();
const formatGatewayTransportErrorJsonMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: {} }),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  formatGatewayTransportErrorJson: (...args: unknown[]) =>
    formatGatewayTransportErrorJsonMock(...args),
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const diagnoseResult = (
  overrides: Partial<SessionsDiagnoseResult> = {},
): SessionsDiagnoseResult => ({
  ok: true,
  ts: 1,
  outcome: "diagnosed",
  selector: { key: "agent:main:main" },
  chosenBecause: "explicit key selector",
  summary: {
    state: "active",
    confidence: "high",
    headline: "A live Gateway or embedded run is visible for this session.",
  },
  session: {
    found: true,
    key: "agent:main:main",
    agentId: "main",
    sessionId: "session-1",
    kind: "direct",
    updatedAt: 1,
    hasActiveRun: true,
  },
  live: {
    gatewayRun: {
      hasActiveRun: true,
      runs: [
        {
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          startedAgeMs: 10,
          expiresInMs: 1000,
        },
      ],
    },
    embeddedRun: {
      active: false,
      sessionId: "session-1",
    },
    diagnostic: {
      present: true,
      state: "processing",
      queueDepth: 0,
      activeWorkKind: "embedded_run",
      lastProgressAgeMs: 5,
    },
    lane: {
      lane: "session:agent:main:main",
      queuedCount: 0,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 1,
    },
  },
  transcript: {
    resolved: true,
    source: "sessionFile",
    recentEventCount: 2,
  },
  findings: [
    {
      code: "active_run_visible",
      severity: "info",
      message: "A live Gateway or embedded run is visible for this session.",
      evidence: ["gateway or embedded run projection is active"],
    },
  ],
  nextChecks: ["openclaw sessions tail --session-key agent:main:main"],
  ...overrides,
});

describe("sessionsDiagnoseCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.exit.mockImplementation(() => {});
    callGatewayMock.mockResolvedValue(diagnoseResult());
    formatGatewayTransportErrorJsonMock.mockReturnValue(null);
  });

  it("calls sessions.diagnose with selector options and renders text sections", async () => {
    await sessionsDiagnoseCommand(
      {
        sessionKey: "agent:main:main",
        agent: "main",
        tail: "50",
        timeoutMs: 7000,
      },
      runtime,
    );

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.diagnose",
        params: {
          key: "agent:main:main",
          agentId: "main",
          tail: 50,
        },
        timeoutMs: 7000,
        requiredMethods: ["sessions.diagnose"],
      }),
    );
    const output = runtime.log.mock.calls.map((call) => stripAnsi(String(call[0]))).join("\n");
    expect(output).toContain("Session");
    expect(output).toContain("Live State");
    expect(output).toContain("Findings");
    expect(output).toContain("Evidence");
    expect(output).toContain("Next Checks");
  });

  it("passes through JSON result", async () => {
    await sessionsDiagnoseCommand({ sessionId: "session-1", json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"outcome": "diagnosed"'));
  });

  it("renders abandoned embedded timeout evidence", async () => {
    const result = diagnoseResult();
    result.live.embeddedRun = {
      active: false,
      sessionId: "session-1",
      abandoned: {
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        abandonedAtMs: 1,
        reason: "timeout",
      },
    };
    callGatewayMock.mockResolvedValue(result);

    await sessionsDiagnoseCommand({ sessionKey: "agent:main:main" }, runtime);

    const output = runtime.log.mock.calls.map((call) => stripAnsi(String(call[0]))).join("\n");
    expect(output).toContain("Embedded run: none abandoned=timeout");
  });

  it("rejects invalid tail before calling the Gateway", async () => {
    await sessionsDiagnoseCommand({ tail: "201" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith("--tail must be an integer between 1 and 200.");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("prints JSON for invalid tail when JSON mode is enabled", async () => {
    await sessionsDiagnoseCommand({ tail: "201", json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"type": "invalid_tail"'));
    expect(runtime.error).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects an explicitly empty selector before calling the Gateway", async () => {
    await sessionsDiagnoseCommand({ sessionId: "   " }, runtime);

    expect(runtime.error).toHaveBeenCalledWith("--session-id cannot be empty.");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("trims selector values before calling the Gateway", async () => {
    await sessionsDiagnoseCommand({ sessionKey: "  agent:main:main  " }, runtime);

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          key: "agent:main:main",
        }),
      }),
    );
  });

  it("rejects ambiguous selectors before calling the Gateway", async () => {
    await sessionsDiagnoseCommand(
      {
        sessionKey: "agent:main:main",
        sessionId: "session-1",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Choose only one of --session-key, --session-id, or --label.",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("prints an upgrade-specific error for older Gateways", async () => {
    callGatewayMock.mockRejectedValue(
      new Error(
        'active gateway does not support required method "sessions.diagnose" for "sessions.diagnose".',
      ),
    );

    await sessionsDiagnoseCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"type": "unsupported_gateway_method"'),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("exits with code 2 when diagnosis completes but no session is found", async () => {
    callGatewayMock.mockResolvedValue({
      ok: true,
      ts: 1,
      outcome: "not_found",
      selector: { key: "missing" },
      summary: {
        state: "not_found",
        confidence: "high",
        headline: "No stored session matched the requested selector.",
      },
      session: { found: false },
      live: {},
      findings: [
        {
          code: "session_not_found",
          severity: "error",
          message: "No stored session matched the requested selector.",
          evidence: ["session store lookup returned no matching row"],
        },
      ],
      nextChecks: ["openclaw sessions"],
    } satisfies SessionsDiagnoseResult);

    await sessionsDiagnoseCommand({ sessionKey: "missing" }, runtime);

    const output = runtime.log.mock.calls.map((call) => stripAnsi(String(call[0]))).join("\n");
    expect(output).toContain("Transcript: not checked");
    expect(runtime.exit).toHaveBeenCalledWith(2);
  });
});
