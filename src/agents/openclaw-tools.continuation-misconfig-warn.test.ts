import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnSpy, debugSpy, infoSpy, errorSpy, traceSpy, fatalSpy, rawSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
  traceSpy: vi.fn(),
  fatalSpy: vi.fn(),
  rawSpy: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  return {
    createSubsystemLogger: (subsystem: string) => ({
      subsystem,
      isEnabled: () => true,
      trace: traceSpy,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
      fatal: fatalSpy,
      raw: rawSpy,
      child: () => ({
        subsystem,
        isEnabled: () => true,
        trace: traceSpy,
        debug: debugSpy,
        info: infoSpy,
        warn: warnSpy,
        error: errorSpy,
        fatal: fatalSpy,
        raw: rawSpy,
        child: () => ({}) as never,
      }),
    }),
  };
});

const mockConfig: Record<string, unknown> = {
  session: { mainKey: "main", scope: "per-sender" },
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});

vi.mock("../plugins/tools.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/tools.js")>("../plugins/tools.js");
  return {
    ...actual,
    getPluginToolMeta: () => undefined,
  };
});

import { createOpenClawTools } from "./openclaw-tools.js";
import { buildInventoryContinuationToolOpts } from "./tools/continuation-inventory-opts.js";

function buildContinueWorkOpts() {
  return {
    requestContinuation: vi.fn(),
  };
}

function buildRequestCompactionOpts() {
  return {
    sessionId: "test-session-x5.1",
    getContextUsage: () => 0.85,
    triggerCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
  };
}

describe("createOpenClawTools — silent partial-registration guard", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it("warns when continuation.enabled=true but neither continueWorkOpts nor requestCompactionOpts are supplied", () => {
    createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [message, meta] = warnSpy.mock.calls[0];
    expect(message).toContain("continuation.enabled=true");
    expect(message).toContain("only continue_delegate will register");
    expect(meta).toMatchObject({ agentSessionKey: "main" });
  });

  it("does NOT warn when continuation is fully configured", () => {
    createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      continueWorkOpts: buildContinueWorkOpts(),
      requestCompactionOpts: buildRequestCompactionOpts(),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn when continuation.enabled is unset", () => {
    createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: { session: { mainKey: "main", scope: "per-sender" } } as never,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn or register continuation tools for an explicit maintenance run", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      disableContinuationTools: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
    });

    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("continue_work");
    expect(names).not.toContain("continue_delegate");
    expect(names).not.toContain("request_compaction");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn when only continueWorkOpts is supplied (request_compaction will not register, but continue_work IS registered — partial-registration concern only fires when neither is supplied)", () => {
    createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      continueWorkOpts: buildContinueWorkOpts(),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  // inventory/catalog callsites (gateway
  // tool-resolution, skills tool-dispatch, tools-effective-inventory) register
  // the continuation tools via stub callbacks (buildInventoryContinuationToolOpts)
  // so the catalog reflects the full surface AND the partial-registration warning
  // is satisfied HONESTLY (callbacks ARE supplied) rather than suppressed by a flag.
  it("does NOT warn when continuation.enabled=true and stub inventory callbacks are supplied (register honestly, not suppress)", () => {
    createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      ...buildInventoryContinuationToolOpts(true),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("registers continue_work + request_compaction when stub inventory callbacks are supplied (catalog reflects full surface)", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      ...buildInventoryContinuationToolOpts(true),
    });

    const names = tools.map((t) => t.name);
    expect(names).toContain("continue_work");
    expect(names).toContain("continue_delegate");
    expect(names).toContain("request_compaction");
  });
});
