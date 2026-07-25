// Tests session usage command output and token accounting summaries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { handleFastCommand, handleUsageCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const loadSessionCostSummaryMock = vi.hoisted(() =>
  vi.fn<() => Promise<SessionCostSummary | null>>(async () => null),
);
const loadCostUsageSummaryMock = vi.hoisted(() =>
  vi.fn<() => Promise<CostUsageSummary>>(async () => ({
    updatedAt: 0,
    days: 30,
    daily: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
  })),
);
type FastModeStateMockResult = {
  mode: boolean | "auto" | undefined;
  enabled: boolean;
  source: "session" | "agent" | "config" | "default";
  fastAutoOnSeconds?: number;
};
const resolveFastModeStateMock = vi.hoisted(() =>
  vi.fn<() => FastModeStateMockResult>(() => ({
    mode: true,
    enabled: true,
    source: "agent",
  })),
);

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: resolveSessionAgentIdMock,
  };
});

vi.mock("../../infra/session-cost-usage.js", () => ({
  loadSessionCostSummary: loadSessionCostSummaryMock,
  loadCostUsageSummary: loadCostUsageSummaryMock,
}));

vi.mock("../../agents/fast-mode.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/fast-mode.js")>(
    "../../agents/fast-mode.js",
  );
  return {
    ...actual,
    resolveFastModeState: resolveFastModeStateMock,
  };
});

function buildUsageParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "/usage cost",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    sessionKey: "agent:target:whatsapp:direct:12345",
    agentId: "main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
    },
  } as unknown as HandleCommandsParams;
}

function buildCostTotals(overrides: Partial<CostUsageTotals> = {}): CostUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...overrides,
  };
}

function expectSessionCostArgs(): Record<string, unknown> {
  expect(loadSessionCostSummaryMock).toHaveBeenCalledTimes(1);
  const call = loadSessionCostSummaryMock.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("expected loadSessionCostSummary call");
  }
  const args = call[0];
  if (!args || typeof args !== "object") {
    throw new Error("expected loadSessionCostSummary args");
  }
  return args as Record<string, unknown>;
}

function expectFastModeArgs(): Record<string, unknown> {
  expect(resolveFastModeStateMock).toHaveBeenCalledTimes(1);
  const call = resolveFastModeStateMock.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("expected resolveFastModeState call");
  }
  const args = call[0];
  if (!args || typeof args !== "object") {
    throw new Error("expected resolveFastModeState args");
  }
  return args as Record<string, unknown>;
}

describe("handleUsageCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    loadSessionCostSummaryMock.mockResolvedValue({
      ...buildCostTotals({
        totalCost: 1.23,
        totalTokens: 100,
        missingCostEntries: 0,
      }),
    });
    loadCostUsageSummaryMock.mockResolvedValue({
      updatedAt: 0,
      days: 30,
      daily: [],
      totals: buildCostTotals({
        totalCost: 4.56,
        missingCostEntries: 0,
      }),
    });
  });

  it("uses the canonical target session agent for /usage cost", async () => {
    const result = await handleUsageCommand(buildUsageParams(), true);

    expect(result?.shouldContinue).toBe(false);
    const args = expectSessionCostArgs();
    expect(args.agentId).toBe("target");
    expect(args.sessionId).toBe("session-1");
    expect(loadCostUsageSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "target" }),
    );
  });

  it("prefers the target session entry from sessionStore for /usage cost", async () => {
    const params = buildUsageParams();
    params.sessionEntry = {
      sessionId: "wrapper-session",
      sessionFile: "/tmp/wrapper-session.jsonl",
      updatedAt: Date.now(),
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        sessionFile: "/tmp/target-session.jsonl",
        updatedAt: Date.now(),
      },
    };

    await handleUsageCommand(params, true);

    const args = expectSessionCostArgs();
    expect(args.sessionId).toBe("target-session");
    expect(args.sessionFile).toBe("/tmp/target-session.jsonl");
  });

  it("prefers the target session entry from sessionStore for /usage footer mode", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      responseUsage: "off",
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        responseUsage: "tokens",
      },
    };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Usage footer: full.");
  });

  it("updates usage footer mode as a session preference", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage tokens";
    params.sessionEntry = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      responseUsage: "full",
    };
    params.sessionStore = { [params.sessionKey]: params.sessionEntry };

    const result = await handleUsageCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Usage footer: tokens.");
    expect(params.sessionEntry.responseUsage).toBe("tokens");
  });

  it("persists an explicit /usage off so a configured default cannot re-enable it", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage off";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        responseUsage: "tokens",
      },
    };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Usage footer: off.");
    expect(params.sessionStore[params.sessionKey]?.responseUsage).toBe("off");
  });

  it("no-arg toggle uses the effective mode (config default) when session is unset", async () => {
    // When session has no override, the effective mode is the config default.
    // The toggle should cycle from that effective value, not from "off".
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage";
    params.cfg = {
      ...params.cfg,
      messages: { responseUsage: "tokens" },
    } as OpenClawConfig;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        // responseUsage is absent — session inherits config default "tokens"
      },
    };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    // Effective current = "tokens" (from config), so cycle → "full"
    expect(result?.reply?.text).toBe("⚙️ Usage footer: full.");
    expect(params.sessionStore[params.sessionKey]?.responseUsage).toBe("full");
  });

  it("/usage reset clears the session override so the config default takes over", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage reset";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        responseUsage: "off",
      },
    };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Usage footer: reset to default.");
    // responseUsage is deleted (undefined) — session now inherits the config default
    expect(params.sessionStore[params.sessionKey]?.responseUsage).toBeUndefined();
  });

  it("/usage inherit (alias) clears the session override", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage inherit";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        responseUsage: "full",
      },
    };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Usage footer: reset to default.");
    expect(params.sessionStore[params.sessionKey]?.responseUsage).toBeUndefined();
  });

  it("explicit off is stored and not treated as unset — config default cannot override it", async () => {
    // This verifies the three-state distinction: "off" vs undefined.
    // When session has explicit "off", the effective value is "off" regardless of config.
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/usage";
    params.cfg = {
      ...params.cfg,
      messages: { responseUsage: "tokens" },
    } as OpenClawConfig;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        responseUsage: "off", // explicit off — stays off despite config default "tokens"
      },
    };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    // Effective current = "off" (explicit, not inherited), so cycle → "tokens"
    expect(result?.reply?.text).toBe("⚙️ Usage footer: tokens.");
  });
});

describe("handleFastCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    resolveFastModeStateMock.mockReturnValue({
      mode: true,
      enabled: true,
      source: "agent",
    });
  });

  it("uses the canonical target session agent for /fast status", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast status";
    params.provider = "openai";
    params.model = "gpt-5.4";

    const result = await handleFastCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const args = expectFastModeArgs();
    expect(args.agentId).toBe("target");
    expect(args.provider).toBe("openai");
    expect(args.model).toBe("gpt-5.4");
    expect(result?.reply?.text).toContain("Current fast mode: on");
  });

  it("shows the resolved auto threshold for /fast status", async () => {
    resolveFastModeStateMock.mockReturnValue({
      mode: "auto",
      enabled: true,
      source: "config",
      fastAutoOnSeconds: 30,
    });
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast status";
    params.provider = "openai-codex";
    params.model = "gpt-5.5";

    const result = await handleFastCommand(params, true);

    expect(result?.reply?.text).toContain("Current fast mode: auto (30 sec) (default: model)");
  });

  it("prefers the target session entry from sessionStore for /fast status", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast status";
    params.provider = "openai";
    params.model = "gpt-5.4";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      fastMode: false,
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        fastMode: true,
      },
    };

    await handleFastCommand(params, true);

    const args = expectFastModeArgs();
    const sessionEntry = args.sessionEntry as Record<string, unknown> | undefined;
    expect(sessionEntry?.sessionId).toBe("target-session");
    expect(sessionEntry?.fastMode).toBe(true);
  });

  it("clears fast mode for /fast default", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast default";
    params.sessionEntry = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      fastMode: true,
    };
    params.sessionStore = { [params.sessionKey]: params.sessionEntry };

    const result = await handleFastCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Fast mode reset to default.");
    expect(params.sessionEntry.fastMode).toBeUndefined();
    expect(params.sessionStore[params.sessionKey]?.fastMode).toBeUndefined();
  });

  it("clears fast mode on the target store entry for /fast default", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast default";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      fastMode: false,
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        fastMode: true,
      },
    };

    const result = await handleFastCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Fast mode reset to default.");
    expect(params.sessionEntry.fastMode).toBe(false);
    expect(params.sessionStore[params.sessionKey]?.fastMode).toBeUndefined();
  });
});
