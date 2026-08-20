import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { driver, execution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";

const tempRoots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), label));
  tempRoots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("cua-computer recording actions", () => {
  it("maps each recording tool while projecting only opaque resource handles", async () => {
    const active = driver();
    let nativeRecordingRoot = "";
    active.callTool.mockImplementation(async (name, args) => {
      switch (name) {
        case "start_recording":
          nativeRecordingRoot = String(args.output_dir);
          await fs.mkdir(path.join(nativeRecordingRoot, "turn-00001"));
          await fs.writeFile(
            path.join(nativeRecordingRoot, "turn-00001", "action.json"),
            JSON.stringify({ tool: "click", arguments: {} }),
          );
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive, {
            text: `recording at ${nativeRecordingRoot}`,
          });
        case "get_recording_state":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive);
        case "stop_recording":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingStopped, {
            text: `${nativeRecordingRoot}/recording.mp4`,
          });
        case "replay_trajectory":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.replay);
        default:
          return cuaToolResult({});
      }
    });
    const computer = await execution(active.session);

    const startedJson = await computer.act(
      JSON.stringify({ action: "start_recording", recordVideo: false }),
    );
    expect(startedJson).not.toContain(nativeRecordingRoot);
    expect(startedJson).not.toContain("native-session");
    const started = JSON.parse(startedJson) as { details: { resourceHandle: string } };
    expect(started.details.resourceHandle).toMatch(/^openclaw:computer-resource:v1:/u);

    const stateJson = await computer.act(JSON.stringify({ action: "get_recording_state" }));
    expect(stateJson).not.toContain("/native/");
    expect(stateJson).toContain(started.details.resourceHandle);

    const stoppedJson = await computer.act(JSON.stringify({ action: "stop_recording" }));
    expect(stoppedJson).not.toContain("recording.mp4");
    expect(stoppedJson).toContain(started.details.resourceHandle);

    const replayJson = await computer.act(
      JSON.stringify({
        action: "replay_trajectory",
        resourceHandle: started.details.resourceHandle,
        delayMs: 25,
        stopOnError: true,
      }),
    );
    expect(replayJson).not.toContain("/native/");
    expect(replayJson).toContain(started.details.resourceHandle);
    expect(active.callTool.mock.calls).toEqual([
      ["start_recording", { output_dir: nativeRecordingRoot, record_video: false }, undefined],
      ["get_recording_state", {}, undefined],
      ["stop_recording", {}, undefined],
      [
        "replay_trajectory",
        { dir: nativeRecordingRoot, delay_ms: 25, stop_on_error: true },
        undefined,
      ],
    ]);

    await computer.close("cancel");
    await expect(fs.access(nativeRecordingRoot)).rejects.toThrow();
  });

  it("rejects malformed, absolute, traversal, and symlink-escaped replay resources", async () => {
    const outside = await tempRoot("openclaw-cua-resource-outside-");
    const active = driver();
    let nativeRecordingRoot = "";
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        nativeRecordingRoot = String(args.output_dir);
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive);
      }
      if (name === "stop_recording") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingStopped);
      }
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.replay);
    });
    const computer = await execution(active.session);

    for (const resourceHandle of [
      "../outside",
      outside,
      "openclaw:computer-resource:v1:unknown",
      "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000",
    ]) {
      await expect(
        computer.act(JSON.stringify({ action: "replay_trajectory", resourceHandle })),
      ).rejects.toThrow("COMPUTER_");
    }

    const started = JSON.parse(
      await computer.act(JSON.stringify({ action: "start_recording" })),
    ) as { details: { resourceHandle: string } };
    await computer.act(JSON.stringify({ action: "stop_recording" }));
    const escapedChild = path.join(nativeRecordingRoot, "escaped-child");
    await fs.symlink(outside, escapedChild, "dir");
    const callsBeforeChildEscape = active.callTool.mock.calls.length;
    await expect(
      computer.act(
        JSON.stringify({
          action: "replay_trajectory",
          resourceHandle: started.details.resourceHandle,
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_RESOURCE");
    expect(active.callTool).toHaveBeenCalledTimes(callsBeforeChildEscape);
    await fs.rm(escapedChild);

    await fs.rm(nativeRecordingRoot, { recursive: true });
    await fs.symlink(outside, nativeRecordingRoot, "dir");
    const callsBeforeReplay = active.callTool.mock.calls.length;
    await expect(
      computer.act(
        JSON.stringify({
          action: "replay_trajectory",
          resourceHandle: started.details.resourceHandle,
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_RESOURCE");
    expect(active.callTool).toHaveBeenCalledTimes(callsBeforeReplay);

    await fs.rm(nativeRecordingRoot);
    await computer.close("cancel");
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
  });

  it("finalizes an in-flight recording once on every execution close", async () => {
    const active = driver();
    let nativeRecordingRoot = "";
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        nativeRecordingRoot = String(args.output_dir);
        await startGate;
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive);
      }
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingStopped);
    });
    const computer = await execution(active.session);

    const start = computer.act(JSON.stringify({ action: "start_recording" }));
    await vi.waitFor(() =>
      expect(active.callTool).toHaveBeenCalledWith("start_recording", expect.anything(), undefined),
    );
    const close = computer.close("cancel");
    releaseStart?.();
    await start;
    await close;
    await computer.close("cancel");

    expect(active.callTool.mock.calls.map(([name]) => name)).toEqual([
      "start_recording",
      "stop_recording",
    ]);
    expect(active.dispose).toHaveBeenCalledOnce();
    await expect(fs.access(nativeRecordingRoot)).rejects.toThrow();
  });
});
