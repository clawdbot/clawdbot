import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: childProcessMocks.spawnSync,
}));

import { createMeetingConfiguredNodeHost } from "./configured-node-host.js";

function createHost() {
  return createMeetingConfiguredNodeHost({
    agentMode: "agent",
    bridgeIdPrefix: "test-node-",
    browser: {
      application: "Google Chrome",
      buildProfileArgs: () => [],
      openedNotes: [],
      openedStatus: "opened",
    },
    browserLabel: "Test meeting",
    commandName: "testmeeting.chrome",
    defaultAudio: {
      backend: "auto",
      bufferBytes: 4_096,
      format: "pcm16-24khz",
    },
    defaultAudioInputCommand: ["legacy-capture"],
    defaultAudioOutputCommand: ["legacy-playback"],
    displayName: "Test meeting",
    meetingLabel: "Test meeting",
    normalizeMeetingKey: (url) => url,
    normalizeUrl: (value) => String(value),
    sharePrerequisiteDeadline: true,
    talkBackModes: new Set(["agent", "bidi"]),
  });
}

describe("configured meeting node host", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("provisions PipeWire-Pulse and probes node-local default commands", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let sinkLoaded = false;
    let sourceLoaded = false;
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "/bin/sh") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command !== "pactl") {
        return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }
      if (args[0] === "info") {
        return { status: 0, stdout: "Server Name: PulseAudio (on PipeWire)", stderr: "" };
      }
      if (args[0] === "load-module") {
        if (args[1] === "module-null-sink") {
          sinkLoaded = true;
        }
        if (args[1] === "module-remap-source") {
          sourceLoaded = true;
        }
        return { status: 0, stdout: "42", stderr: "" };
      }
      if (args[0] === "list" && args[2] === "sinks") {
        return {
          status: 0,
          stdout: sinkLoaded ? "42\topenclaw_meeting_audio\tPipeWire" : "",
          stderr: "",
        };
      }
      if (args[0] === "list" && args[2] === "sources") {
        return {
          status: 0,
          stdout: sourceLoaded ? "43\topenclaw_meeting_audio\tPipeWire" : "",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = JSON.parse(await createHost()(JSON.stringify({ action: "setup" }))) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({
      ok: true,
      audioBackend: "pipewire-pulse",
      audioDeviceLabel: "OpenClaw Meeting Audio",
    });
    expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
      "/bin/sh",
      ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", "parec"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
      "/bin/sh",
      ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", "pacat"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining(["legacy-capture"]),
      expect.anything(),
    );
  });

  it("probes explicit command overrides after provisioning the backend", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "/bin/sh") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "info") {
        return { status: 0, stdout: "Server Name: PulseAudio (on PipeWire)", stderr: "" };
      }
      if (args[0] === "list" && args[2] === "sinks") {
        return { status: 0, stdout: "42\topenclaw_meeting_audio\tPipeWire", stderr: "" };
      }
      if (args[0] === "list" && args[2] === "sources") {
        return { status: 0, stdout: "43\topenclaw_meeting_audio\tPipeWire", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await createHost()(
      JSON.stringify({
        action: "setup",
        audioInputCommand: ["trusted-capture", "--raw"],
        audioOutputCommand: ["trusted-playback", "--raw"],
        bargeInInputCommand: ["trusted-barge-in"],
      }),
    );

    for (const command of ["trusted-capture", "trusted-playback", "trusted-barge-in"]) {
      expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
        "/bin/sh",
        ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
        expect.objectContaining({ encoding: "utf8" }),
      );
    }
  });
});
