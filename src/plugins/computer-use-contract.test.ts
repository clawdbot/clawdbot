import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_STALE_OBSERVATION,
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
  it("owns the shared provider ref-lifecycle error code", () => {
    const contract = JSON.parse(
      readFileSync(
        new URL("../../test/fixtures/computer-ref-lifecycle-contract.json", import.meta.url),
        "utf8",
      ),
    ) as { staleErrorCode: string };

    expect(contract.staleErrorCode).toBe(COMPUTER_STALE_OBSERVATION);
  });

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
    expect(
      parseComputerActParamsJSON(
        JSON.stringify({
          action: "browser_click",
          browserRef: "browser-1",
          pageRef: "page-1",
          observationId: "observation-1",
          elementRef: "element-1",
          inputRoute: "dom_event",
        }),
      ),
    ).toMatchObject({ action: "browser_click", browserRef: "browser-1" });
    expect(() =>
      parseComputerActParamsJSON(
        JSON.stringify({
          action: "browser_prepare",
          windowRef: "window-1",
          strategy: { kind: "existing_profile" },
        }),
      ),
    ).toThrow("COMPUTER_INVALID_REQUEST");
  });

  it("accepts the portable recording family without native path or helper inputs", () => {
    const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";
    for (const input of [
      { action: "get_recording_state" },
      { action: "start_recording", recordVideo: true },
      { action: "stop_recording" },
      { action: "replay_trajectory", resourceHandle, delayMs: 25, stopOnError: false },
      {
        action: "browser_set_input_files",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
        resourceHandles: [resourceHandle],
      },
      {
        action: "browser_download",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
      },
    ]) {
      expect(parseComputerActParamsJSON(JSON.stringify(input))).toEqual(input);
    }

    for (const input of [
      { action: "start_recording", output_dir: "/tmp/recording" },
      { action: "start_recording", helperPath: "/tmp/ffmpeg" },
      { action: "replay_trajectory", dir: "../outside" },
      { action: "replay_trajectory", ffmpegPath: "/tmp/ffmpeg" },
      { action: "get_window_state", windowRef: "window-1", session: "native-session" },
      { action: "left_click", binaryPath: "/tmp/cua-driver" },
      { action: "left_click", socketPath: "/tmp/cua.sock" },
      { action: "left_click", driverArgs: ["--dangerously-bypass-approvals"] },
      { providerTool: "click", arguments: { x: 1, y: 2 } },
      {
        action: "browser_set_input_files",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
        files: ["/tmp/input.txt"],
      },
      {
        action: "browser_download",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
        destinationRoot: "/tmp/downloads",
      },
    ]) {
      expect(() => parseComputerActParamsJSON(JSON.stringify(input))).toThrow(
        "COMPUTER_INVALID_REQUEST",
      );
    }
  });

  it("accepts canonical input success and rejects obsolete cursor fields", () => {
    expect(parseComputerActResult({ ok: true })).toEqual({ ok: true });
    const openDetails = { coordinateSpace: { unit: "provider-defined" }, vendorValue: 42 };
    expect(parseComputerActResult({ ok: true, details: openDetails })).toEqual({
      ok: true,
      details: openDetails,
    });
    expect(() => parseComputerActResult({ ok: true, cursorX: 12, cursorY: 34 })).toThrow(
      "COMPUTER_CONTRACT_MISMATCH",
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
    const executionId = "123e4567-e89b-42d3-a456-426614174000";
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
    const paramsJSON = JSON.stringify({ executionId });
    await expect(commands[0]!.handle(paramsJSON, undefined, context)).resolves.toBe("snapshot");
    await expect(commands[1]!.handle(paramsJSON, undefined, context)).resolves.toBe("act");
    expect(openExecution).toHaveBeenCalledOnce();
    expect(openExecution).toHaveBeenCalledWith({ executionId, sessionKey: "session-1" });
    expect(snapshot).toHaveBeenCalledWith(paramsJSON, signal);
    expect(act).toHaveBeenCalledWith(paramsJSON, signal);

    const stop = commands[0]!.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    stop?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith("node-host-stop"));
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it("refuses a second mutating execution and closes only the exact host execution", async () => {
    const firstId = "123e4567-e89b-42d3-a456-426614174000";
    const secondId = "223e4567-e89b-42d3-a456-426614174000";
    const commands: OpenClawPluginNodeHostCommand[] = [];
    const closes: string[] = [];
    const openExecution = vi.fn(async () => ({
      snapshot: vi.fn(async () => "snapshot"),
      act: vi.fn(async () => "act"),
      close: vi.fn(async (reason: string) => {
        closes.push(reason);
      }),
    }));
    const provider: ComputerUseProvider = {
      id: "fixture",
      label: "Fixture",
      capabilities: () => ({
        contractVersion: 2,
        provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
        actions: ["start_recording", "stop_recording"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: true, agentCursor: false, multiDisplay: false },
      }),
      isAvailable: () => true,
      openExecution,
    };
    registerComputerUseProvider(
      { registerNodeHostCommand: (command) => commands.push(command) },
      provider,
    );
    const computer = commands.find((command) => command.command === "computer.act")!;

    await expect(
      computer.handle(JSON.stringify({ action: "start_recording", executionId: firstId })),
    ).resolves.toBe("act");
    await expect(
      computer.handle(JSON.stringify({ action: "stop_recording", executionId: secondId })),
    ).rejects.toThrow("COMPUTER_HOST_BUSY");
    expect(openExecution).toHaveBeenCalledOnce();

    await computer.handle(
      JSON.stringify({ action: "__close_execution", executionId: firstId, reason: "completion" }),
    );
    await expect(
      computer.handle(JSON.stringify({ action: "start_recording", executionId: secondId })),
    ).resolves.toBe("act");
    expect(openExecution).toHaveBeenCalledTimes(2);
    await commands.find((command) => command.command === "screen.snapshot")!.onDisconnect?.();
    expect(closes).toEqual(["completion", "gateway-disconnect"]);
  });
});
