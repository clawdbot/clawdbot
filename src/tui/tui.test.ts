import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { getSlashCommands, parseCommand } from "./commands.js";
import {
  createBackspaceDeduper,
  drainAndStopTuiSafely,
  isIgnorableTuiStopError,
  resolveCodexCliBin,
  resolveCtrlCAction,
  resolveFinalAssistantText,
  resolveGatewayDisconnectState,
  resolveInitialTuiAgentId,
  resolveLocalAuthCliInvocation,
  resolveLocalAuthSpawnCwd,
  resolveLocalAuthSpawnOptions,
  resolveTuiSessionKey,
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
    expect(commands.some((command) => command.name === "context")).toBe(true);
    expect(commands.some((command) => command.name === "commands")).toBe(true);
  });

  it("includes /auth in local embedded mode", () => {
    const commands = getSlashCommands({ local: true });
    expect(commands.some((command) => command.name === "auth")).toBe(true);
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
        cwd: "/tmp/openclaw/projects/ops/src",
      }),
    ).toBe("main");
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
});

describe("resolveGatewayDisconnectState", () => {
  it("returns pairing recovery guidance when disconnect reason requires pairing", () => {
    const state = resolveGatewayDisconnectState("gateway closed (1008): pairing required");
    expect(state.connectionStatus).toContain("pairing required");
    expect(state.activityStatus).toBe("pairing required: run openclaw devices list");
    expect(state.pairingHint).toContain("openclaw devices list");
  });

  it("falls back to idle for generic disconnect reasons", () => {
    const state = resolveGatewayDisconnectState("network timeout");
    expect(state.connectionStatus).toBe("gateway disconnected: network timeout");
    expect(state.activityStatus).toBe("idle");
    expect(state.pairingHint).toBeUndefined();
  });
});

describe("createBackspaceDeduper", () => {
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
    const { dedupe, advance } = createTimedDedupe();

    expect(dedupe("\x7f")).toBe("\x7f");
    advance(1);
    expect(dedupe("\x08")).toBe("");
  });

  it("preserves backspace events outside the dedupe window", () => {
    const { dedupe, advance } = createTimedDedupe();

    expect(dedupe("\x7f")).toBe("\x7f");
    advance(10);
    expect(dedupe("\x7f")).toBe("\x7f");
  });

  it("treats ASCII BS as backspace when it is the first event", () => {
    const { dedupe, advance } = createTimedDedupe();

    expect(dedupe("\x08")).toBe("\x08");
    advance(1);
    expect(dedupe("\x7f")).toBe("");
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

describe("TUI shutdown safety", () => {
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
    expect(() => {
      stopTuiSafely(() => {
        throw new Error("setRawMode EBADF");
      });
    }).not.toThrow();
  });

  it("rethrows non-ignorable stop errors", () => {
    expect(() => {
      stopTuiSafely(() => {
        throw new Error("boom");
      });
    }).toThrow("boom");
  });
});

describe("resolveCodexCliBin", () => {
  it("returns a string path when codex CLI is installed", () => {
    const result = resolveCodexCliBin();
    // In this test environment codex is installed; verify it returns a non-empty path
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("codex");
    }
  });

  it("returns null or a valid path (never throws)", () => {
    // The function should never throw regardless of environment
    expect(() => resolveCodexCliBin()).not.toThrow();
    const result = resolveCodexCliBin();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("resolveLocalAuthCliInvocation", () => {
  it("uses the source runner when dist is unavailable", () => {
    expect(
      resolveLocalAuthCliInvocation({
        execPath: "/usr/bin/node",
        wrapperPath: "/repo/openclaw.mjs",
        runNodePath: "/repo/scripts/run-node.mjs",
        hasDistEntry: false,
        hasRunNodeScript: true,
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["/repo/scripts/run-node.mjs", "models", "auth", "login"],
    });
  });

  it("uses the packaged wrapper when dist is available", () => {
    expect(
      resolveLocalAuthCliInvocation({
        execPath: "/usr/bin/node",
        wrapperPath: "/repo/openclaw.mjs",
        runNodePath: "/repo/scripts/run-node.mjs",
        hasDistEntry: true,
        hasRunNodeScript: true,
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["/repo/openclaw.mjs", "models", "auth", "login"],
    });
  });
});

describe("resolveLocalAuthSpawnOptions", () => {
  it("enables shell mode for Windows cmd shims", () => {
    expect(
      resolveLocalAuthSpawnOptions({
        command: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
        platform: "win32",
      }),
    ).toEqual({ shell: true });
  });

  it("enables shell mode for Windows bat shims", () => {
    expect(
      resolveLocalAuthSpawnOptions({
        command: "C:\\tools\\codex.bat",
        platform: "win32",
      }),
    ).toEqual({ shell: true });
  });

  it("keeps direct execution for non-wrapper commands", () => {
    expect(
      resolveLocalAuthSpawnOptions({
        command: "/usr/local/bin/codex",
        platform: "linux",
      }),
    ).toEqual({});
    expect(
      resolveLocalAuthSpawnOptions({
        command: "C:\\tools\\codex.exe",
        platform: "win32",
      }),
    ).toEqual({});
  });
});

describe("resolveLocalAuthSpawnCwd", () => {
  it("runs the packaged wrapper from the repo root", () => {
    expect(
      resolveLocalAuthSpawnCwd({
        args: ["/repo/openclaw.mjs", "models", "auth", "login"],
        defaultCwd: "/worktree/subdir",
      }),
    ).toBe("/repo");
  });

  it("runs the source fallback helper from the repo root", () => {
    expect(
      resolveLocalAuthSpawnCwd({
        args: ["/repo/scripts/run-node.mjs", "models", "auth", "login"],
        defaultCwd: "/worktree/subdir",
      }),
    ).toBe("/repo");
  });

  it("keeps the caller cwd for direct codex exec", () => {
    expect(
      resolveLocalAuthSpawnCwd({
        args: ["login"],
        defaultCwd: "/worktree/subdir",
      }),
    ).toBe("/worktree/subdir");
  });
});
