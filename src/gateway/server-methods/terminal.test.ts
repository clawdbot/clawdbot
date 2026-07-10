import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTerminalLaunch } from "../terminal/launch.js";
import { terminalHandlers } from "./terminal.js";

function makeOpts(
  params: unknown,
  terminalConfig: { enabled?: boolean } | undefined,
  terminalPolicyConfig?: OpenClawConfig,
) {
  const sessions = {
    open: vi.fn(),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    close: vi.fn(() => true),
    attach: vi.fn(() => ({
      sessionId: "s1",
      agentId: "main",
      cwd: "/work",
      shell: "/bin/zsh",
      buffer: "history",
    })),
    list: vi.fn(() => [
      {
        sessionId: "s1",
        agentId: "main",
        shell: "/bin/zsh",
        cwd: "/work",
        attached: false,
        createdAtMs: 1,
      },
    ]),
    snapshot: vi.fn(() => "10%\r100%"),
  };
  const respond = vi.fn();
  const runtimeConfig = { gateway: { terminal: terminalConfig } } as OpenClawConfig;
  const policyConfig = terminalPolicyConfig ?? runtimeConfig;
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy: (agentId?: string) =>
      resolveTerminalLaunch({
        config: policyConfig,
        enabled: policyConfig.gateway?.terminal?.enabled === true,
        agentId,
        configuredShell: policyConfig.gateway?.terminal?.shell,
      }),
    isTerminalEnabled: () => policyConfig.gateway?.terminal?.enabled === true,
    terminalSessions: sessions,
    logGateway: { info: vi.fn() },
    // Only the fields the terminal handlers touch are needed here.
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0]["context"];
  const opts = {
    params: params as Record<string, unknown>,
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0];
  return { opts, sessions, respond };
}

describe("terminal.open policy snapshot", () => {
  it("rejects reopening after an accepted disable while runtime restart is pending", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      { gateway: { terminal: { enabled: false } } },
    );

    await terminalHandlers["terminal.open"](opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("rejects reopening after an accepted sandbox tightening", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    );

    await terminalHandlers["terminal.open"](opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });
});

describe("terminal.input kill switch", () => {
  it("writes to the session when the terminal is enabled", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: true },
    );
    await terminalHandlers["terminal.input"](opts);
    expect(sessions.write).toHaveBeenCalledWith("conn-1", "s1", "ls\n");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("closes the session and rejects input when the terminal is disabled", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: false },
    );
    await terminalHandlers["terminal.input"](opts);
    // The disabled kill switch must stop live input and tear the session down.
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });

  it("defaults to disabled when terminal config is absent", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1", data: "ls\n" }, undefined);
    await terminalHandlers["terminal.input"](opts);
    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });
});

describe("terminal.resize kill switch", () => {
  it("rejects and closes when disabled", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", cols: 80, rows: 24 },
      { enabled: false },
    );
    await terminalHandlers["terminal.resize"](opts);
    expect(sessions.resize).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });
});

describe("terminal.attach", () => {
  it("returns the session facts plus the replay buffer", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1" }, { enabled: true });
    await terminalHandlers["terminal.attach"](opts);
    expect(sessions.attach).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "history",
    });
  });

  it("refuses to hand out a PTY stream when the terminal is disabled", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1" }, { enabled: false });
    await terminalHandlers["terminal.attach"](opts);
    expect(sessions.attach).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("rejects unknown sessions", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "gone" }, { enabled: true });
    sessions.attach.mockReturnValue(undefined as never);
    await terminalHandlers["terminal.attach"](opts);
    expect(respond.mock.calls[0][0]).toBe(false);
  });
});

describe("terminal.list", () => {
  it("lists sessions with the confined flag applied", async () => {
    const { opts, respond } = makeOpts(undefined, { enabled: true });
    await terminalHandlers["terminal.list"](opts);
    expect(respond).toHaveBeenCalledWith(true, {
      sessions: [
        {
          sessionId: "s1",
          agentId: "main",
          shell: "/bin/zsh",
          cwd: "/work",
          attached: false,
          createdAtMs: 1,
          confined: false,
        },
      ],
    });
  });

  it("returns an empty list when the terminal is disabled", async () => {
    const { opts, sessions, respond } = makeOpts(undefined, { enabled: false });
    await terminalHandlers["terminal.list"](opts);
    expect(sessions.list).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { sessions: [] });
  });
});

describe("terminal.text", () => {
  it("returns the buffer rendered as plain text", async () => {
    const { opts, respond } = makeOpts({ sessionId: "s1" }, { enabled: true });
    await terminalHandlers["terminal.text"](opts);
    // The raw snapshot carries a CR overwrite; the handler collapses it.
    expect(respond).toHaveBeenCalledWith(true, { text: "100%" });
  });

  it("strips every ESC and C1 CSI final byte from the session snapshot", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1" }, { enabled: true });
    const finals = Array.from({ length: 0x7e - 0x40 + 1 }, (_, offset) =>
      String.fromCharCode(0x40 + offset),
    );
    const sequences = ["\u001B[", "\u009B"]
      .flatMap((introducer) => finals.map((finalByte) => introducer + finalByte))
      .join("");
    sessions.snapshot.mockReturnValue(`before${sequences}after`);

    await terminalHandlers["terminal.text"](opts);

    expect(respond).toHaveBeenCalledWith(true, { text: "beforeafter" });
  });

  it("rejects unknown sessions and disabled terminals", async () => {
    const unknown = makeOpts({ sessionId: "gone" }, { enabled: true });
    unknown.sessions.snapshot.mockReturnValue(undefined as never);
    await terminalHandlers["terminal.text"](unknown.opts);
    expect(unknown.respond.mock.calls[0][0]).toBe(false);

    const disabled = makeOpts({ sessionId: "s1" }, { enabled: false });
    await terminalHandlers["terminal.text"](disabled.opts);
    expect(disabled.sessions.snapshot).not.toHaveBeenCalled();
    expect(disabled.respond.mock.calls[0][0]).toBe(false);
  });
});
