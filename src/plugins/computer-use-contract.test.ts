import { describe, expect, it, vi } from "vitest";
import {
  parseComputerActParamsJSON,
  parseScreenSnapshotResult,
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "./computer-use-contract.js";
import type { OpenClawPluginNodeHostCommand, OpenClawPluginNodeInvokePolicy } from "./types.js";

describe("Computer Use wire contract", () => {
  it("validates the canonical computer.act payload", () => {
    expect(
      parseComputerActParamsJSON(
        JSON.stringify({
          action: "left_click",
          displayFrameId: "frame-1",
          x: 10,
          y: 20,
          refWidth: 1280,
        }),
      ),
    ).toEqual({
      action: "left_click",
      displayFrameId: "frame-1",
      x: 10,
      y: 20,
      refWidth: 1280,
    });
    expect(() => parseComputerActParamsJSON('{"action":"left_click","unexpected":true}')).toThrow(
      "COMPUTER_INVALID_REQUEST",
    );
  });

  it("projects the canonical screen.snapshot result", () => {
    expect(
      parseScreenSnapshotResult({
        format: "jpeg",
        base64: "aGk=",
        displayFrameId: "frame-1",
        width: 100,
        height: 50,
        capturedAtMs: 42,
        ignored: true,
      }),
    ).toEqual({
      format: "jpeg",
      base64: "aGk=",
      displayFrameId: "frame-1",
      width: 100,
      height: 50,
      capturedAtMs: 42,
    });
  });
});

describe("Computer Use provider registration", () => {
  it("registers one command pair and dispatches both through one execution", async () => {
    const commands: OpenClawPluginNodeHostCommand[] = [];
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    const snapshot = vi.fn(async () => "snapshot");
    const act = vi.fn(async () => "act");
    const close = vi.fn(async () => {});
    const stopWatching = vi.fn();
    const openExecution = vi.fn(async () => ({ snapshot, act, close }));
    const provider: ComputerUseProvider = {
      id: "fixture",
      label: "Fixture",
      isAvailable: () => true,
      watchAvailability: () => stopWatching,
      openExecution,
    };

    registerComputerUseProvider(
      {
        registerNodeHostCommand: (command) => commands.push(command),
        registerNodeInvokePolicy: (policy) => policies.push(policy),
      },
      provider,
    );

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ commands: ["computer.act"], dangerous: true });

    const signal = new AbortController().signal;
    const context = { sendNodeEvent: vi.fn(), sessionKey: "session-1", signal };
    await expect(commands[0]!.handle("{}", undefined, context)).resolves.toBe("snapshot");
    await expect(commands[1]!.handle("{}", undefined, context)).resolves.toBe("act");
    expect(openExecution).toHaveBeenCalledOnce();
    expect(openExecution).toHaveBeenCalledWith({ sessionKey: "session-1" });
    expect(snapshot).toHaveBeenCalledWith("{}", signal);
    expect(act).toHaveBeenCalledWith("{}", signal);

    const stop = commands[0]!.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    stop?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith("node-host-stop"));
    expect(stopWatching).toHaveBeenCalledOnce();
  });
});
