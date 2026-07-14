import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
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
    snapshot: vi.fn(() => "10%\r100%"),
  };
  const runtimeConfig = { gateway: { terminal: terminalConfig } } as OpenClawConfig;
  const policy = createTerminalLaunchPolicy(runtimeConfig);
  if (terminalPolicyConfig) {
    policy.prepareConfig(terminalPolicyConfig, { restartPending: true });
  }
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy: (agentId?: string) => policy.resolve(agentId),
    isTerminalEnabled: () => policy.isEnabled(),
    terminalSessions: sessions,
    logGateway: { info: vi.fn() },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0]["context"];
  const opts = {
    params: params as Record<string, unknown>,
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0];
  return { opts, sessions, respond };
}

describe("terminal gateway policy", () => {
  it("rejects reopening after an accepted disable while restart is pending", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      { gateway: { terminal: { enabled: false } } },
    );

    await expectDefined(
      terminalHandlers["terminal.open"],
      'terminalHandlers["terminal.open"] test invariant',
    )(opts);

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

    await expectDefined(
      terminalHandlers["terminal.open"],
      'terminalHandlers["terminal.open"] test invariant',
    )(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("closes a live session and rejects input after disablement", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: false },
    );

    await expectDefined(
      terminalHandlers["terminal.input"],
      'terminalHandlers["terminal.input"] test invariant',
    )(opts);

    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });

  it("sanitizes terminal snapshots before returning plain text", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "s1" }, { enabled: true });
    const finals = Array.from({ length: 0x7e - 0x40 + 1 }, (_, offset) =>
      String.fromCharCode(0x40 + offset),
    );
    const sequences = ["\u001B[", "\u009B"]
      .flatMap((introducer) => finals.map((finalByte) => introducer + finalByte))
      .join("");
    sessions.snapshot.mockReturnValue(`before${sequences}after`);

    await expectDefined(
      terminalHandlers["terminal.text"],
      'terminalHandlers["terminal.text"] test invariant',
    )(opts);

    expect(respond).toHaveBeenCalledWith(true, { text: "beforeafter" });
  });
});
