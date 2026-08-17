// Covers core TUI state transitions and backend event rendering.
import { EventEmitter } from "node:events";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { withEnv } from "../test-utils/env.js";
import { getSlashCommands, parseCommand } from "./commands.js";
import {
  beginTuiShutdown,
  createBackspaceDeduper,
  createDeferredTuiFinish,
  createTuiConnectionLineage,
  createTuiSignalHandlers,
  drainAndStopTuiSafely,
  installTuiTerminalLossExitHandler,
  isIgnorableTuiStopError,
  isTuiTerminalLossError,
  resolveCtrlCAction,
  resolveFinalAssistantText,
  resolveGatewayDisconnectState,
  resolveInitialTuiAgentId,
  resolveTuiToolsToggleActivityStatus,
  isTuiBusyActivityStatus,
  resolveTuiCtrlCAction,
  resolveTuiLocalAuthCliInvocation,
  resolveTuiShutdownHardExitMs,
  resolveTuiSessionKey,
  resolveTuiSessionSelection,
  scheduleProcessExitAfterTuiReturn,
  stopTuiSafely,
} from "./tui.js";

describe("resolveFinalAssistantText", () => {
  it("falls back to streamed text when final text is empty", () => {
    expect(resolveFinalAssistantText({ finalText: "", streamedText: "Hello" })).toBe("Hello");
  });

  it("prefers the final text when present", () => {
    expect(
      resolveFinalAssistantText({
        finalText: "All done",
        streamedText: "partial",
      }),
    ).toBe("All done");
  });

  it("falls back to formatted error text when final and streamed text are empty", () => {
    expect(
      resolveFinalAssistantText({
        finalText: "",
        streamedText: "",
        errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
      }),
    ).toContain("HTTP 401");
  });

  it("formats malformed streaming fragment errors when final and streamed text are empty", () => {
    expect(
      resolveFinalAssistantText({
        finalText: "",
        streamedText: "",
        errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
      }),
    ).toBe("LLM streaming response contained a malformed fragment. Please try again.");
  });
});

describe("resolveTuiLocalAuthCliInvocation", () => {
  it("filters inspector flags while preserving the current CLI runtime context", () => {
    const originalArgv = [...process.argv];
    try {
      const cliEntry = path.resolve("openclaw.mjs");
      process.argv[1] = cliEntry;

      expect(
        resolveTuiLocalAuthCliInvocation({
          provider: "test-provider",
          execArgv: [
            "--import",
            "/repo/node_modules/tsx/dist/loader.mjs",
            "--inspect-brk=0",
            "--trace-warnings",
          ],
        }),
      ).toStrictEqual({
        command: process.execPath,
        args: [
          "--import",
          "/repo/node_modules/tsx/dist/loader.mjs",
          "--trace-warnings",
          cliEntry,
          "models",
          "auth",
          "login",
          "--provider",
          "test-provider",
        ],
        cwd: path.resolve("."),
      });
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe("tui slash commands", () => {
  it("treats /elev as an alias for /elevated", () => {
    expect(parseCommand("/elev on")).toEqual({ name: "elevated", args: "on" });
  });

  it("normalizes alias case", () => {
    expect(parseCommand("/ELEV off")).toEqual({
      name: "elevated",
      args: "off",
    });
  });

  it("includes gateway text commands", () => {
    const commands = getSlashCommands({});
    const names = commands.map((command) => command.name);
    expect(names).toContain("context");
    expect(names).toContain("commands");
  });

  it("includes /auth in local embedded mode", () => {
    const commands = getSlashCommands({ local: true });
    expect(commands.map((command) => command.name)).toContain("auth");
  });
});

describe("isTuiBusyActivityStatus", () => {
  it("treats finishing context as a visible busy status", () => {
    expect(isTuiBusyActivityStatus("finishing context")).toBe(true);
  });

  it("treats post-connect initialization as a visible busy status", () => {
    expect(isTuiBusyActivityStatus("starting up")).toBe(true);
  });
});

describe("resolveTuiToolsToggleActivityStatus", () => {
  it("preserves busy status while an active run exists", () => {
    expect(
      resolveTuiToolsToggleActivityStatus({
        currentStatus: "streaming",
        toolsExpanded: true,
      }),
    ).toBe("streaming");
  });

  it("preserves finishing context after the active run id clears", () => {
    expect(
      resolveTuiToolsToggleActivityStatus({
        currentStatus: "finishing context",
        toolsExpanded: false,
      }),
    ).toBe("finishing context");
  });

  it("uses the tool toggle status when activity is idle", () => {
    expect(
      resolveTuiToolsToggleActivityStatus({
        currentStatus: "idle",
        toolsExpanded: false,
      }),
    ).toBe("tools collapsed");
  });
});

describe("resolveTuiShutdownHardExitMs", () => {
  it("keeps gateway shutdown bounded by the hard-exit timer", () => {
    expect(resolveTuiShutdownHardExitMs({ localMode: false })).toBe(2000);
  });

  it("adds local run shutdown grace before forcing embedded shutdown", () => {
    withEnv({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "3456" }, () => {
      expect(resolveTuiShutdownHardExitMs({ localMode: true })).toBe(5456);
    });
  });

  it("ignores partial local run shutdown grace values", () => {
    withEnv({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "3456abc" }, () => {
      expect(resolveTuiShutdownHardExitMs({ localMode: true })).toBe(122000);
    });
  });

  it("clamps oversized local run shutdown grace values", () => {
    withEnv({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: String(Number.MAX_SAFE_INTEGER) }, () => {
      expect(resolveTuiShutdownHardExitMs({ localMode: true })).toBe(MAX_TIMER_TIMEOUT_MS + 2000);
    });
  });
});

describe("resolveTuiSessionKey", () => {
  it("uses global only as the default when scope is global", () => {
    expect(
      resolveTuiSessionKey({
        raw: "",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("global");
    expect(
      resolveTuiSessionKey({
        raw: "test123",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("agent:main:test123");
  });

  it("keeps explicit agent-prefixed keys unchanged", () => {
    expect(
      resolveTuiSessionKey({
        raw: "agent:ops:incident",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("agent:ops:incident");
  });

  it("unwraps an agent-qualified global key after agent selection", () => {
    expect(
      resolveTuiSessionKey({
        raw: "AGENT:Work:GLOBAL",
        sessionScope: "per-sender",
        currentAgentId: "work",
        sessionMainKey: "main",
      }),
    ).toBe("global");
  });

  it.each([
    {
      raw: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org",
      expected: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org",
    },
    {
      raw: "Matrix:Channel:!MixedRoomAbCdEf:example.org",
      expected: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org",
    },
    {
      raw: "Agent:Main:Matrix:Channel:!MixedRoomAbCdEf:example.org:Thread:$EventAbCdEf",
      expected: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org:thread:$EventAbCdEf",
    },
    {
      raw: "Agent:Ops:Matrix:Channel:!MixedRoomAbCdEf:example.org",
      expected: "agent:ops:matrix:channel:!MixedRoomAbCdEf:example.org",
    },
    {
      raw: "agent:main:signal:group:AbC123=",
      expected: "agent:main:signal:group:AbC123=",
    },
    {
      raw: "Agent:Ops:Signal:Group:AbC123=",
      expected: "agent:ops:signal:group:AbC123=",
    },
    {
      raw: "Signal:Group:AbC123=",
      expected: "agent:main:signal:group:AbC123=",
    },
    {
      raw: "Telegram:Group:MixedHandle",
      expected: "agent:main:telegram:group:mixedhandle",
    },
  ])("preserves canonical provider-owned session identity for $raw", ({ raw, expected }) => {
    expect(
      resolveTuiSessionKey({
        raw,
        sessionScope: "per-sender",
        currentAgentId: "main",
        sessionMainKey: "main",
      }),
    ).toBe(expected);
  });

  it("lowercases session keys with uppercase characters", () => {
    // Uppercase in agent-prefixed form
    expect(
      resolveTuiSessionKey({
        raw: "agent:main:Test1",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("agent:main:test1");
    // Uppercase in bare form (prefixed by currentAgentId)
    expect(
      resolveTuiSessionKey({
        raw: "Test1",
        sessionScope: "global",
        currentAgentId: "main",
        sessionMainKey: "agent:main:main",
      }),
    ).toBe("agent:main:test1");
  });
});

describe("resolveInitialTuiAgentId", () => {
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      list: [
        { id: "main", workspace: "/tmp/openclaw" },
        { id: "ops", workspace: "/tmp/openclaw/projects/ops" },
      ],
    },
  };

  it("infers agent from cwd when session is not agent-prefixed", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "",
        cwd: "/tmp/openclaw/projects/ops/src",
      }),
    ).toBe("ops");
  });

  it("keeps explicit agent prefix from --session", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "agent:main:incident",
        agentId: "ops",
        cwd: "/tmp/openclaw/projects/ops/src",
      }),
    ).toBe("main");
  });

  it("keeps an explicit global-session agent ahead of workspace inference", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "global",
        agentId: "ops",
        cwd: "/tmp/openclaw",
      }),
    ).toBe("ops");
  });

  it("falls back when cwd has no matching workspace", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "",
        cwd: "/var/tmp/unrelated",
      }),
    ).toBe("main");
  });

  it("falls back when the working directory was deleted", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });

    try {
      expect(resolveInitialTuiAgentId({ cfg, fallbackAgentId: "main" })).toBe("main");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("falls back to a retained legacy owner", () => {
    const retained = retainLegacyDefaultAgentId(structuredClone(cfg), "ops");

    expect(resolveInitialTuiAgentId({ cfg: retained, cwd: "/var/tmp/unrelated" })).toBe("ops");
  });

  it("keeps an ownerless explicit fleet selection-required", () => {
    expect(() => resolveInitialTuiAgentId({ cfg, cwd: "/var/tmp/unrelated" })).toThrow(
      AgentSelectionRequiredError,
    );
  });

  it("uses the persisted fixed-store owner for an unscoped global session", () => {
    const restartConfig: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    expect(
      resolveInitialTuiAgentId({
        cfg: restartConfig,
        initialSessionInput: "global",
        cwd: "/tmp/openclaw",
      }),
    ).toBe("ops");
    expect(resolveInitialTuiAgentId({ cfg: restartConfig, cwd: "/tmp/openclaw" })).toBe("ops");
  });

  it("uses the persisted fixed-store owner for any bare initial session key", () => {
    const restartConfig: OpenClawConfig = {
      session: { store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    expect(
      resolveInitialTuiAgentId({
        cfg: restartConfig,
        initialSessionInput: "incident-42",
        cwd: "/tmp/openclaw",
      }),
    ).toBe("ops");
  });
});

describe("resolveTuiSessionSelection", () => {
  it("keeps a fixed-store bare key with its persisted owner", () => {
    const cfg: OpenClawConfig = {
      session: { store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        list: [{ id: "ops" }, { id: "research" }],
      },
    };

    expect(
      resolveTuiSessionSelection({
        raw: "incident-42",
        cfg,
        sessionScope: "per-sender",
        currentAgentId: "research",
        sessionMainKey: "main",
      }),
    ).toEqual({ key: "incident-42", agentId: "ops" });
  });

  it("carries an explicit owner while unwrapping global storage", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", list: [{ id: "ops" }, { id: "research" }] },
    };
    expect(
      resolveTuiSessionSelection({
        raw: "agent:ops:global",
        cfg,
        sessionScope: "per-sender",
        currentAgentId: "research",
        sessionMainKey: "main",
      }),
    ).toEqual({ key: "global", agentId: "ops" });
  });
});

describe("resolveGatewayDisconnectState", () => {
  it("shows startup progress while the gateway keeps retrying", () => {
    expect(resolveGatewayDisconnectState({ reason: "gateway starting" })).toEqual({
      connectionStatus: "gateway starting",
      activityStatus: "starting up",
    });
  });

  it("returns scope-upgrade recovery guidance when disconnect reason requires pairing", () => {
    const state = resolveGatewayDisconnectState({
      reason: "gateway closed (1008): pairing required",
    });
    expect(state.connectionStatus).toContain("pairing required");
    expect(state.activityStatus).toBe("device approval needed: preview latest request");
    expect(state.remediation).toContain("openclaw devices approve --latest");
    expect(state.remediation).toContain("openclaw devices approve <requestId>");
    expect(state.remediation).toContain("--url");
    expect(state.remediation).toContain("--token/--password");
    // Must steer users to `devices`, not the unrelated chat-DM `pairing` command.
    expect(state.remediation).not.toContain("openclaw pairing");
  });

  it("uses structured pairing details before the generic close reason", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "PAIRING_REQUIRED", reason: "scope-upgrade" },
      reason: "connect failed",
    });
    expect(state.activityStatus).toBe("device approval needed: preview latest request");
    expect(state.connectionStatus).toContain("scope upgrade pending approval");
    expect(state.remediation).toContain("openclaw devices approve --latest");
  });

  it("shows the device-token rotation command for structured token mismatch", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      reason: "device token mismatch",
    });
    expect(state.activityStatus).toBe("gateway authentication needs attention");
    expect(state.remediation).toContain(
      "openclaw devices rotate --device <deviceId> --role operator",
    );
  });

  it("shows wait-and-retry guidance for a temporary authentication lockout", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "AUTH_RATE_LIMITED" },
      reason: "unauthorized: too many failed authentication attempts (retry later)",
    });
    expect(state.activityStatus).toBe("gateway authentication temporarily rate-limited");
    expect(state.remediation).toContain("temporary authentication lockout");
    expect(state.remediation).not.toContain("gateway.remote.token");
    expect(state.remediation).not.toContain("devices rotate");
  });

  it("falls back to idle for generic disconnect reasons", () => {
    const state = resolveGatewayDisconnectState({ reason: "network timeout" });
    expect(state.connectionStatus).toBe("gateway disconnected: network timeout");
    expect(state.activityStatus).toBe("idle");
    expect(state.remediation).toBeUndefined();
  });
});

describe("createBackspaceDeduper", () => {
  function withLegacyBackspaceEnv<T>(fn: () => T): T {
    return withEnv(
      {
        WT_SESSION: undefined,
        SSH_CONNECTION: undefined,
        SSH_CLIENT: undefined,
        SSH_TTY: undefined,
      },
      fn,
    );
  }

  function createTimedDedupe(start = 1000) {
    let now = start;
    const dedupe = createBackspaceDeduper({
      dedupeWindowMs: 8,
      now: () => now,
    });
    return {
      dedupe,
      advance: (deltaMs: number) => {
        now += deltaMs;
      },
    };
  }

  it("suppresses duplicate backspace events within the dedupe window", () => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();

      expect(dedupe("\x7f")).toBe("\x7f");
      advance(1);
      expect(dedupe("\x08")).toBe("");
    });
  });

  it("preserves backspace events outside the dedupe window", () => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();

      expect(dedupe("\x7f")).toBe("\x7f");
      advance(10);
      expect(dedupe("\x7f")).toBe("\x7f");
    });
  });

  it("treats ASCII BS as backspace when it is the first event", () => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();

      expect(dedupe("\x08")).toBe("\x08");
      advance(1);
      expect(dedupe("\x7f")).toBe("");
    });
  });

  it.each([
    {
      name: "consecutive DEL events",
      input: ["\x7f", "\x7f"],
      expected: ["\x7f", "\x7f"],
    },
    {
      name: "consecutive ASCII BS events",
      input: ["\x08", "\x08"],
      expected: ["\x08", "\x08"],
    },
    {
      name: "an intervening printable key",
      input: ["\x7f", "a", "\x08"],
      expected: ["\x7f", "a", "\x08"],
    },
    {
      name: "Kitty backspace press, repeat, and release events",
      input: ["\x1b[127;1u", "\x1b[127;1:2u", "\x1b[127;1:3u"],
      expected: ["\x1b[127;1u", "\x1b[127;1:2u", "\x1b[127;1:3u"],
    },
    {
      name: "bracketed paste between legacy backspaces",
      input: ["\x7f", "\x1b[200~\x08\x1b[201~", "\x08"],
      expected: ["\x7f", "\x1b[200~\x08\x1b[201~", "\x08"],
    },
    {
      name: "independently repeated complementary legacy pairs",
      input: ["\x7f", "\x08", "\x7f", "\x08"],
      expected: ["\x7f", "", "\x7f", ""],
    },
  ])("handles $name", ({ input, expected }) => {
    withLegacyBackspaceEnv(() => {
      const { dedupe } = createTimedDedupe();

      expect(input.map(dedupe)).toEqual(expected);
    });
  });

  it("preserves complementary legacy events outside the dedupe window", () => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();

      expect(dedupe("\x7f")).toBe("\x7f");
      advance(10);
      expect(dedupe("\x08")).toBe("\x08");
    });
  });

  it("preserves Ctrl+Backspace in Windows Terminal", () => {
    withEnv(
      {
        WT_SESSION: "openclaw-tui-test",
        SSH_CONNECTION: undefined,
        SSH_CLIENT: undefined,
        SSH_TTY: undefined,
      },
      () => {
        const { dedupe } = createTimedDedupe();

        expect(["\x7f", "\x08", "\x7f"].map(dedupe)).toEqual(["\x7f", "\x08", "\x7f"]);
      },
    );
  });

  it("still deduplicates legacy backspace through an SSH session in Windows Terminal", () => {
    withEnv(
      {
        WT_SESSION: "openclaw-tui-test",
        SSH_CONNECTION: "192.0.2.10 12345 192.0.2.20 22",
        SSH_CLIENT: undefined,
        SSH_TTY: undefined,
      },
      () => {
        const { dedupe } = createTimedDedupe();

        expect(["\x7f", "\x08"].map(dedupe)).toEqual(["\x7f", ""]);
      },
    );
  });

  it("never suppresses non-backspace keys", () => {
    const dedupe = createBackspaceDeduper();
    expect(dedupe("a")).toBe("a");
    expect(dedupe("\x1b[A")).toBe("\x1b[A");
  });
});

describe("resolveCtrlCAction", () => {
  it("clears input and arms exit on first ctrl+c when editor has text", () => {
    expect(resolveCtrlCAction({ hasInput: true, now: 2000, lastCtrlCAt: 0 })).toEqual({
      action: "clear",
      nextLastCtrlCAt: 2000,
    });
  });

  it("exits on second ctrl+c within the exit window", () => {
    expect(resolveCtrlCAction({ hasInput: false, now: 2800, lastCtrlCAt: 2000 })).toEqual({
      action: "exit",
      nextLastCtrlCAt: 2000,
    });
  });

  it("shows warning when exit window has elapsed", () => {
    expect(resolveCtrlCAction({ hasInput: false, now: 3501, lastCtrlCAt: 2000 })).toEqual({
      action: "warn",
      nextLastCtrlCAt: 3501,
    });
  });
});

describe("resolveTuiCtrlCAction", () => {
  it("exits immediately after a gateway disconnect", () => {
    expect(
      resolveTuiCtrlCAction({
        hasInput: false,
        now: 2000,
        lastCtrlCAt: 0,
        wasDisconnected: true,
      }),
    ).toEqual({
      action: "exit",
      nextLastCtrlCAt: 0,
    });
  });

  it("clears a nonempty draft before exiting after a gateway disconnect", () => {
    expect(
      resolveTuiCtrlCAction({
        hasInput: true,
        now: 2000,
        lastCtrlCAt: 0,
        wasDisconnected: true,
      }),
    ).toEqual({
      action: "clear",
      nextLastCtrlCAt: 2000,
    });
  });

  it("forces exit when shutdown is already in progress", () => {
    expect(
      resolveTuiCtrlCAction({
        hasInput: true,
        now: 2000,
        lastCtrlCAt: 1000,
        exitRequested: true,
      }),
    ).toEqual({
      action: "force-exit",
      nextLastCtrlCAt: 1000,
    });
  });
});

describe("createTuiConnectionLineage", () => {
  it("keeps a startup retry before the first hello out of reconnect recovery", () => {
    const lineage = createTuiConnectionLineage();

    lineage.disconnect();
    expect(lineage.wasDisconnected()).toBe(false);
    expect(lineage.connect()).toBe(false);

    lineage.disconnect();
    expect(lineage.wasDisconnected()).toBe(true);
    expect(lineage.connect()).toBe(true);
  });
});

describe("TUI shutdown safety", () => {
  const beginTestShutdown = (overrides: Partial<Parameters<typeof beginTuiShutdown>[0]> = {}) =>
    beginTuiShutdown({
      stopClient: vi.fn(),
      stopTui: vi.fn(),
      disposeStatus: vi.fn(),
      requestFinish: vi.fn(),
      forceExit: vi.fn(),
      hardExitMs: 2000,
      keepHardExitArmed: true,
      onError: vi.fn(),
      ...overrides,
    });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("disposes every status animation before teardown and after it settles", async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const statusTimer = setInterval(tick, 1000);
    const waitingTimer = setInterval(tick, 120);
    const loaderTimer = setInterval(tick, 80);
    const statusTimeout = setTimeout(tick, 5000);
    const loader = { stop: vi.fn(() => clearInterval(loaderTimer)) };
    const disposeStatus = vi.fn(() => {
      clearInterval(statusTimer);
      clearInterval(waitingTimer);
      clearTimeout(statusTimeout);
      loader.stop();
    });

    beginTestShutdown({ disposeStatus, keepHardExitArmed: false });

    expect(disposeStatus).toHaveBeenCalledOnce();
    expect(loader.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(0);

    expect(disposeStatus).toHaveBeenCalledTimes(2);
    expect(loader.stop).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("drains terminal input before stopping the TUI", async () => {
    const calls: string[] = [];
    const drainInput = vi.fn(async () => {
      calls.push("drain");
    });
    const stop = vi.fn(() => {
      calls.push("stop");
    });

    await drainAndStopTuiSafely({
      stop,
      terminal: { drainInput },
    });

    expect(drainInput).toHaveBeenCalledOnce();
    expect(drainInput).toHaveBeenCalledWith(500, 100);
    expect(stop).toHaveBeenCalledOnce();
    expect(calls).toEqual(["drain", "stop"]);
  });

  it("still stops when the terminal does not support drainInput", async () => {
    const stop = vi.fn();

    await drainAndStopTuiSafely({
      stop,
      terminal: {},
    });

    expect(stop).toHaveBeenCalledOnce();
  });

  it("rethrows non-ignorable stop errors after draining", async () => {
    const drainInput = vi.fn(async () => {});
    const stop = vi.fn(() => {
      throw new Error("boom");
    });

    await expect(
      drainAndStopTuiSafely({
        stop,
        terminal: { drainInput },
      }),
    ).rejects.toThrow("boom");

    expect(drainInput).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("treats setRawMode EBADF errors as ignorable", () => {
    expect(isIgnorableTuiStopError(new Error("setRawMode EBADF"))).toBe(true);
    expect(
      isIgnorableTuiStopError({
        code: "EBADF",
        syscall: "setRawMode",
      }),
    ).toBe(true);
  });

  it("does not ignore unrelated stop errors", () => {
    expect(isIgnorableTuiStopError(new Error("something else failed"))).toBe(false);
    expect(isIgnorableTuiStopError({ code: "EIO", syscall: "write" })).toBe(false);
  });

  it("swallows only ignorable stop errors", () => {
    expect(
      stopTuiSafely(() => {
        throw new Error("setRawMode EBADF");
      }),
    ).toBeUndefined();
  });

  it("rethrows non-ignorable stop errors", () => {
    expect(() => {
      stopTuiSafely(() => {
        throw new Error("boom");
      });
    }).toThrow("boom");
  });

  it("classifies terminal-loss IO errors", () => {
    expect(isTuiTerminalLossError({ code: "EIO", syscall: "read" })).toBe(true);
    expect(isTuiTerminalLossError({ code: "EPIPE", syscall: "write" })).toBe(true);
    expect(isTuiTerminalLossError(new Error("read EIO at TTY.onStreamRead"))).toBe(true);
    expect(isTuiTerminalLossError(new Error("ordinary failure"))).toBe(false);
  });

  it("requests exit once when the TUI terminal closes", () => {
    const stdin = new EventEmitter() as EventEmitter & {
      on(event: "close" | "end", listener: () => void): unknown;
      off(event: "close" | "end", listener: () => void): unknown;
    };
    const stdout = new EventEmitter() as EventEmitter & {
      on(event: "close" | "end", listener: () => void): unknown;
      off(event: "close" | "end", listener: () => void): unknown;
    };
    const requestExit = vi.fn();

    const cleanup = installTuiTerminalLossExitHandler(requestExit, { stdin, stdout });
    stdin.emit("end");
    stdout.emit("close");
    cleanup();
    stdin.emit("close");

    expect(requestExit).toHaveBeenCalledTimes(1);
  });

  it("resolves terminal-loss exits requested before the TUI finish handler is installed", () => {
    const deferredFinish = createDeferredTuiFinish();
    const finish = vi.fn();

    deferredFinish.requestFinish();
    expect(finish).not.toHaveBeenCalled();

    deferredFinish.setFinish(finish);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("forces process exit when gateway teardown never settles", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const requestFinish = vi.fn();
    const timer = beginTestShutdown({
      stopClient: () => new Promise<void>(() => {}),
      requestFinish,
      forceExit: () => process.exit(130),
    });

    expect((timer as NodeJS.Timeout).hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(130);
    expect(requestFinish).not.toHaveBeenCalled();
  });

  it("forces process exit after SIGTERM when gateway teardown never settles", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const requestExit = vi.fn(() => {
      beginTestShutdown({
        stopClient: () => new Promise<void>(() => {}),
        forceExit: () => process.exit(130),
      });
    });
    const { sigtermHandler } = createTuiSignalHandlers({
      handleCtrlC: vi.fn(),
      requestExit,
    });

    sigtermHandler();
    expect(requestExit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("keeps the force-exit deadline armed after already-drained teardown settles", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const requestFinish = vi.fn();
    beginTestShutdown({
      requestFinish,
      forceExit,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestFinish).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(forceExit).toHaveBeenCalledOnce();
  });

  it("completes healthy shutdown promptly without waiting for the force-exit deadline", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const forceExit = vi.fn();
    beginTestShutdown({
      stopClient: async () => {
        calls.push("client");
      },
      stopTui: async () => {
        calls.push("tui");
      },
      disposeStatus: () => {
        calls.push("status");
      },
      requestFinish: () => {
        calls.push("finish");
      },
      forceExit,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["status", "client", "tui", "status", "finish"]);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("attempts terminal shutdown after transport teardown rejects", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const transportError = new Error("transport stop failed");
    let finishTuiStop: (() => void) | undefined;
    const stopTui = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls.push("tui");
          finishTuiStop = resolve;
        }),
    );
    const clearTimeoutFn = vi.fn();
    const requestFinish = vi.fn(() => calls.push("finish"));
    const onError = vi.fn((error: unknown) => {
      calls.push("error");
      expect(error).toBe(transportError);
    });

    beginTestShutdown({
      stopClient: async () => {
        calls.push("client");
        throw transportError;
      },
      stopTui,
      requestFinish,
      onError,
      keepHardExitArmed: false,
      clearTimeoutFn,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["client", "tui"]);
    expect(clearTimeoutFn).not.toHaveBeenCalled();
    expect(requestFinish).not.toHaveBeenCalled();

    finishTuiStop?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["client", "tui", "error", "finish"]);
    expect(stopTui).toHaveBeenCalledOnce();
    expect(clearTimeoutFn).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(requestFinish).toHaveBeenCalledOnce();
  });

  it("reports transport and terminal shutdown errors in phase order", async () => {
    vi.useFakeTimers();
    const transportError = new Error("transport stop failed");
    const terminalError = new Error("terminal stop failed");
    const onError = vi.fn();
    const requestFinish = vi.fn();

    beginTestShutdown({
      stopClient: async () => {
        throw transportError;
      },
      stopTui: async () => {
        throw terminalError;
      },
      onError,
      requestFinish,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([transportError, terminalError]);
    expect(requestFinish).toHaveBeenCalledOnce();
  });

  it("cancels the hard-exit deadline for embedded TUI callers after clean shutdown", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    beginTestShutdown({
      forceExit,
      keepHardExitArmed: false,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("does not keep a clean standalone TUI alive for the watchdog deadline", () => {
    const unref = vi.fn();
    const setTimeoutFn = vi.fn((_callback: () => void, delayMs: number) => {
      expect(delayMs).toBe(2000);
      return { unref };
    });
    const exit = vi.fn();
    const writeStderr = vi.fn();

    scheduleProcessExitAfterTuiReturn({ setTimeoutFn, exit, writeStderr });

    expect(setTimeoutFn).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("forces standalone TUI exit on deadline while another handle lingers", async () => {
    vi.useFakeTimers();
    const lingeringHandle = setInterval(() => {}, 60_000);
    const exit = vi.fn();
    const writeStderr = vi.fn();

    const timer = scheduleProcessExitAfterTuiReturn({ exit, writeStderr });

    expect((timer as NodeJS.Timeout).hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeStderr).toHaveBeenCalledWith("openclaw tui forcing process exit after return\n");
    expect(exit).toHaveBeenCalledWith(0);
    clearInterval(lingeringHandle);
  });
});
