import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderStartRemoteRecording,
  type RunCommand,
} from "../../scripts/e2e/telegram-desktop-crabbox.ts";
import {
  confirmQrLink,
  parseRecorderArgs,
  readRecorderSession,
  type RecorderOperations,
  type RecorderSession,
  renderGoldenImagePreflight,
  renderLaunchDesktop,
  renderPrepareQr,
  renderReadQrLink,
  renderWaitForMainWindow,
  startRecorder,
  stopRecorder,
  writeRecorderSession,
} from "../../scripts/e2e/telegram-desktop-recorder.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-desktop-recorder-"));
  tempDirs.push(dir);
  return dir;
}

function testSession(): RecorderSession {
  return {
    chat: "-1001234567890",
    desktopSessionId: "987654321",
    keepBox: false,
    leaseId: "cbx_test123",
    provider: "aws",
    recordFps: 24,
    remotePaths: {
      desktopLog: "/tmp/recorder/telegram-desktop.log",
      ffmpegLog: "/tmp/recorder/ffmpeg.log",
      ffmpegPid: "/tmp/recorder/ffmpeg.pid",
      finalScreenshot: "/tmp/recorder/final.png",
      video: "/tmp/recorder/session.mp4",
    },
    schemaVersion: 1,
    startedAt: "2026-08-15T12:00:00.000Z",
    userDriver: ["python3", "driver.py", "--account", "qa shared"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("Telegram Desktop recorder CLI", () => {
  it("parses start defaults and a shell-style user driver prefix", () => {
    expect(
      parseRecorderArgs([
        "start",
        "--output-dir",
        ".artifacts/telegram",
        "--chat",
        "-1001234567890",
        "--user-driver",
        `python3 driver.py --account "qa shared"`,
      ]),
    ).toEqual({
      chat: "-1001234567890",
      command: "start",
      crabboxClass: "standard",
      idleTimeout: "1h",
      json: false,
      leaseId: undefined,
      messageId: undefined,
      outputDir: ".artifacts/telegram",
      provider: "aws",
      recordFps: 24,
      ttl: "2h",
      userDriver: ["python3", "driver.py", "--account", "qa shared"],
    });
  });

  it("parses each session verb", () => {
    expect(parseRecorderArgs(["view", "--session", "recorder.json", "--message-id", "42"])).toEqual(
      { command: "view", messageId: "42", sessionPath: "recorder.json" },
    );
    expect(
      parseRecorderArgs(["screenshot", "--session", "recorder.json", "--output", "shot.png"]),
    ).toEqual({ command: "screenshot", output: "shot.png", sessionPath: "recorder.json" });
    expect(
      parseRecorderArgs([
        "stop",
        "--session",
        "recorder.json",
        "--crop",
        "telegram-window",
        "--keep-box",
      ]),
    ).toEqual({
      command: "stop",
      crop: "telegram-window",
      keepBox: true,
      sessionPath: "recorder.json",
    });
    expect(parseRecorderArgs(["status", "--session", "recorder.json"])).toEqual({
      command: "status",
      sessionPath: "recorder.json",
    });
  });

  it("requires start inputs and a -100 private-group chat id", () => {
    expect(() => parseRecorderArgs(["start"])).toThrow("--chat is required");
    expect(() =>
      parseRecorderArgs([
        "start",
        "--output-dir",
        ".artifacts/telegram",
        "--chat",
        "1234",
        "--user-driver",
        "driver",
      ]),
    ).toThrow("beginning with -100");
    expect(() =>
      parseRecorderArgs([
        "start",
        "--output-dir",
        ".artifacts/telegram",
        "--chat",
        "-1001234",
        "--user-driver",
        `driver "unterminated`,
      ]),
    ).toThrow("valid shell-style command prefix");
  });
});

describe("Telegram Desktop recorder remote contract", () => {
  it("leases the catalog-only Telegram variant image, never the generic desktop default", async () => {
    const root = makeTempDir();
    const calls: Array<{ args: string[]; command: string }> = [];
    const mockedRun: RunCommand = async (params) => {
      calls.push({ args: params.args, command: params.command });
      if (params.args[0] === "warmup") {
        return { stderr: "", stdout: "leased cbx_0a1b2c slug=quiet-crab" };
      }
      return { stderr: "", stdout: "" };
    };
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => {
        throw new Error("stop after warmup");
      }),
      runCommand: mockedRun,
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async () => ({ stderr: "", stdout: "" })),
    } satisfies RecorderOperations;

    await expect(
      startRecorder(
        root,
        {
          command: "start",
          chat: "-1001234567890",
          crabboxClass: "standard",
          idleTimeout: "1h",
          json: false,
          outputDir: "out",
          provider: "aws",
          recordFps: 24,
          ttl: "2h",
          userDriver: ["python3", "driver.py"],
        },
        operations,
      ),
    ).rejects.toThrow("stop after warmup");

    const warmup = calls.find((call) => call.args[0] === "warmup");
    expect(warmup?.args).toEqual([
      "warmup",
      "--provider",
      "aws",
      "--target",
      "linux",
      "--desktop",
      "--image-sdk",
      "telegram-desktop=7.0.9",
      "--class",
      "standard",
      "--idle-timeout",
      "1h",
      "--ttl",
      "2h",
    ]);
    // Failure after leasing must not leak the variant box.
    expect(calls).toContainEqual({
      args: ["stop", "--provider", "aws", "cbx_0a1b2c"],
      command: "crabbox",
    });
  });

  it("renders only golden-image desktop operations", () => {
    const scripts = [
      renderGoldenImagePreflight(),
      renderLaunchDesktop(),
      renderPrepareQr(),
      renderReadQrLink(),
      renderWaitForMainWindow(),
      renderStartRemoteRecording({
        paths: {
          ffmpegLog: "/tmp/recorder/ffmpeg.log",
          ffmpegPid: "/tmp/recorder/ffmpeg.pid",
          video: "/tmp/recorder/session.mp4",
        },
        recordFps: 24,
      }),
    ].join("\n");

    expect(scripts).toContain("Telegram Desktop recorder golden image contract");
    expect(scripts).toContain("/opt/Telegram/Telegram");
    expect(scripts).toContain("/var/lib/crabbox/telegram-desktop-version");
    expect(scripts).toContain("DISPLAY=:99 xdpyinfo");
    expect(scripts).toContain("wmctrl xdotool scrot ffmpeg zbarimg xdpyinfo");
    expect(scripts.toLowerCase()).not.toMatch(/apt-get|curl|wget|tdlib|python/u);
  });

  it("passes a decoded QR link only to the local confirm-qr command", async () => {
    const link = "tg://login?token=credential-like-value";
    const run = vi.fn<RunCommand>(async () => ({
      stderr: "",
      stdout: JSON.stringify({ ok: true, session: { id: 91234, isPasswordPending: false } }),
    }));

    await expect(
      confirmQrLink({
        cwd: "/repo",
        link,
        run,
        userDriver: ["python3", "driver.py", "--account", "qa"],
      }),
    ).resolves.toBe("91234");
    expect(run).toHaveBeenCalledWith({
      args: ["driver.py", "--account", "qa", "confirm-qr", "--link", link, "--json"],
      command: "python3",
      cwd: "/repo",
      redactValues: [link],
    });
  });
});

describe("Telegram Desktop recorder session lifecycle", () => {
  it("round-trips recorder.json schema version 1", () => {
    const sessionPath = path.join(makeTempDir(), "recorder.json");
    const session = testSession();

    writeRecorderSession(sessionPath, session);

    expect(readRecorderSession(sessionPath)).toEqual(session);
    expect(fs.statSync(sessionPath).mode & 0o777).toBe(0o600);
  });

  it("still stops Crabbox and reports failure when local session termination fails", async () => {
    const root = makeTempDir();
    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, testSession());
    const calls: Array<{ args: string[]; command: string }> = [];
    const mockedRun: RunCommand = async (params) => {
      calls.push({ args: params.args, command: params.command });
      if (params.args.includes("terminate-session")) {
        throw new Error("terminate failed");
      }
      return { stderr: "", stdout: JSON.stringify({ ok: true }) };
    };
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => ({
        sshHost: "host",
        sshKey: "/tmp/key",
        sshPort: "22",
        sshUser: "user",
      })),
      runCommand: mockedRun,
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async () => ({ stderr: "", stdout: "" })),
    } satisfies RecorderOperations;

    await expect(
      stopRecorder(root, { command: "stop", keepBox: false, sessionPath }, operations),
    ).rejects.toThrow("terminate Telegram Desktop session: terminate failed");

    expect(calls).toContainEqual({
      args: [
        "driver.py",
        "--account",
        "qa shared",
        "terminate-session",
        "--session-id",
        "987654321",
        "--json",
      ],
      command: "python3",
    });
    expect(calls).toContainEqual({
      args: ["stop", "--provider", "aws", "cbx_test123"],
      command: "crabbox",
    });
    const stopped = readRecorderSession(sessionPath);
    expect(stopped.stoppedAt).toBeDefined();
    expect(stopped.cleanupErrors).toContain("terminate Telegram Desktop session: terminate failed");
  });
});
