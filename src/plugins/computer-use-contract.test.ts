import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_USE_V2_ACTION_NAMES,
  parseComputerActParamsJSON,
  parseComputerActResult,
  parseComputerUseCapabilityDescriptor,
  parseScreenSnapshotResult,
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "./computer-use-contract.js";
import type { OpenClawPluginNodeHostCommand } from "./types.js";

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

  it("owns the complete v2 action-name union", () => {
    expect(COMPUTER_USE_V2_ACTION_NAMES).toEqual([
      "screenshot",
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "mouse_move",
      "left_click_drag",
      "left_mouse_down",
      "left_mouse_up",
      "scroll",
      "type",
      "key",
      "hold_key",
      "wait",
      "list_apps",
      "list_windows",
      "get_accessibility_tree",
      "get_cursor_position",
      "get_window_state",
      "launch_app",
      "kill_app",
      "bring_to_front",
      "set_value",
      "zoom",
      "get_browser_state",
      "browser_prepare",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_dialog",
      "browser_set_input_files",
      "browser_download",
      "browser_pointer",
      "escalate_scope",
      "get_recording_state",
      "start_recording",
      "stop_recording",
      "replay_trajectory",
      "invoke_menu",
    ]);
  });

  it("validates closed v2 action families without turning params into an optional bag", () => {
    expect(
      parseComputerActParamsJSON(
        JSON.stringify({
          action: "get_window_state",
          windowRef: "window-1",
          query: "button",
          depth: 4,
          maxElements: 200,
        }),
      ),
    ).toMatchObject({ action: "get_window_state", windowRef: "window-1" });
    expect(() =>
      parseComputerActParamsJSON(
        JSON.stringify({ action: "get_window_state", windowRef: "window-1", app: "wrong-family" }),
      ),
    ).toThrow("COMPUTER_INVALID_REQUEST");
    expect(() => parseComputerActParamsJSON(JSON.stringify({ action: "browser_click" }))).toThrow(
      "COMPUTER_INVALID_REQUEST",
    );
  });

  it("caps semantic observations and provider detail records", () => {
    const element = {
      elementRef: "element-1",
      role: "button",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(
      parseComputerActResult({
        ok: true,
        observation: {
          kind: "window",
          observationId: "observation-1",
          elements: Array.from({ length: 2_000 }, () => element),
        },
        details: Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [`key-${index}`, index]),
        ),
      }),
    ).toMatchObject({ ok: true });
    expect(() =>
      parseComputerActResult({
        ok: true,
        observation: {
          kind: "window",
          elements: Array.from({ length: 2_001 }, () => element),
        },
      }),
    ).toThrow("COMPUTER_CONTRACT_MISMATCH");
    expect(() =>
      parseComputerActResult({
        ok: true,
        details: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`key-${index}`, index]),
        ),
      }),
    ).toThrow("COMPUTER_CONTRACT_MISMATCH");
  });

  it("validates the bounded node capability descriptor", () => {
    expect(
      parseComputerUseCapabilityDescriptor({
        contractVersion: 2,
        provider: { id: "cua", label: "CUA", generation: "generation-1" },
        actions: ["screenshot", "left_click"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      }),
    ).toMatchObject({ contractVersion: 2 });
    expect(() =>
      parseComputerUseCapabilityDescriptor({
        contractVersion: 2,
        provider: { id: "cua", label: "CUA", generation: "generation-1" },
        actions: ["left_click", "left_click"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      }),
    ).toThrow("COMPUTER_CONTRACT_MISMATCH");
  });
});

describe("Computer Use provider registration", () => {
  it("registers one command pair and dispatches both through one execution", async () => {
    const commands: OpenClawPluginNodeHostCommand[] = [];
    const snapshot = vi.fn(async () => "snapshot");
    const act = vi.fn(async () => "act");
    const close = vi.fn(async () => {});
    const stopWatching = vi.fn();
    const openExecution = vi.fn(async () => ({ snapshot, act, close }));
    const provider: ComputerUseProvider = {
      id: "fixture",
      label: "Fixture",
      capabilities: () => ({
        contractVersion: 2,
        provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
        actions: ["screenshot", "left_click"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      }),
      isAvailable: () => true,
      watchAvailability: () => stopWatching,
      openExecution,
    };

    registerComputerUseProvider(
      { registerNodeHostCommand: (command) => commands.push(command) },
      provider,
    );

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);

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
