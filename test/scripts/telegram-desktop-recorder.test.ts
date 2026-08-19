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
  parseWindowGeometry,
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
  viewRecorder,
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
    leaseOwned: true,
    imageSource: "telegram-desktop=7.0.9",
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
    window: { height: 1000, width: 650, x: 635, y: 40 },
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
  it("parses start defaults and a whitespace-separated user driver prefix", () => {
    expect(
      parseRecorderArgs([
        "start",
        "--output-dir",
        ".artifacts/telegram",
        "--chat",
        "-1001234567890",
        "--user-driver",
        "uv  run driver.py --json",
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
      provider: "docker",
      recordFps: 24,
      ttl: "2h",
      userDriver: ["uv", "run", "driver.py", "--json"],
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
        "driver",
        "--provider",
        "hetzner",
      ]),
    ).toThrow("--provider must be aws or docker");
    expect(() =>
      parseRecorderArgs([
        "start",
        "--output-dir",
        ".artifacts/telegram",
        "--chat",
        "-1001234",
        "--user-driver",
        "   ",
      ]),
    ).toThrow("--user-driver is required");
  });
});

describe("Telegram Desktop recorder remote contract", () => {
  it.each([
    {
      expectedArgs: [
        "warmup",
        "--provider",
        "docker",
        "--target",
        "linux",
        "--desktop",
        "--class",
        "standard",
        "--idle-timeout",
        "1h",
        "--ttl",
        "2h",
      ],
      expectedImageEnv: "openclaw-telegram-desktop:7.0.9",
      provider: "docker" as const,
    },
    {
      expectedArgs: [
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
      ],
      expectedImageEnv: undefined,
      provider: "aws" as const,
    },
  ])(
    "leases the $provider Telegram image without changing the generic default",
    async (testCase) => {
      const root = makeTempDir();
      const calls: Array<{ args: string[]; command: string; env?: NodeJS.ProcessEnv }> = [];
      const mockedRun: RunCommand = async (params) => {
        calls.push({ args: params.args, command: params.command, env: params.env });
        if (params.command === "docker") {
          return { stderr: "", stdout: "[]" };
        }
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
            provider: testCase.provider,
            recordFps: 24,
            ttl: "2h",
            userDriver: ["python3", "driver.py"],
          },
          operations,
        ),
      ).rejects.toThrow("stop after warmup");

      const warmup = calls.find((call) => call.args[0] === "warmup");
      expect(warmup?.args).toEqual(testCase.expectedArgs);
      expect(warmup?.env?.CRABBOX_LOCAL_CONTAINER_IMAGE).toBe(testCase.expectedImageEnv);
      expect(warmup?.args.includes("--image-sdk")).toBe(testCase.provider === "aws");
      expect(calls).toContainEqual({
        args: ["stop", "--provider", testCase.provider, "cbx_0a1b2c"],
        command: "crabbox",
        env: undefined,
      });
    },
  );

  it("fails before warmup when docker cannot inspect the local Telegram image", async () => {
    const root = makeTempDir();
    const calls: Array<{ args: string[]; command: string }> = [];
    const mockedRun: RunCommand = async (params) => {
      calls.push({ args: params.args, command: params.command });
      throw new Error("No such image");
    };
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => {
        throw new Error("must not inspect");
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
          provider: "docker",
          recordFps: 24,
          ttl: "2h",
          userDriver: ["python3", "driver.py"],
        },
        operations,
      ),
    ).rejects.toThrow(
      "docker image inspect openclaw-telegram-desktop:7.0.9 failed: No such image. Build it with bash scripts/mantis/build-telegram-desktop-image.sh when the image is absent.",
    );
    expect(calls).toEqual([
      {
        args: ["image", "inspect", "openclaw-telegram-desktop:7.0.9"],
        command: "docker",
      },
    ]);
    expect(operations.inspectCrabbox).not.toHaveBeenCalled();
  });

  // A run once reported a missing image while docker held it, because this wrapper
  // replaced docker's own failure with its guess. The daemon's text has to survive.
  it("keeps the docker failure text in the thrown message", async () => {
    const root = makeTempDir();
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => {
        throw new Error("must not inspect");
      }),
      runCommand: (async () => {
        throw new Error("permission denied while trying to connect to the Docker daemon socket");
      }) satisfies RunCommand,
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
          provider: "docker",
          recordFps: 24,
          ttl: "2h",
          userDriver: ["python3", "driver.py"],
        },
        operations,
      ),
    ).rejects.toThrow("permission denied while trying to connect to the Docker daemon socket");
  });

  it("keeps the SSH failure text after exhausting login attempts", async () => {
    const root = makeTempDir();
    let qrAttempt = 0;
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => ({
        sshHost: "host",
        sshKey: "/tmp/key",
        sshPort: "22",
        sshUser: "user",
      })),
      runCommand: vi.fn<RunCommand>(async () => ({
        stderr: "",
        stdout: JSON.stringify({ ok: true, session: { id: 91234, isPasswordPending: false } }),
      })),
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async ({ command }: { command: string }) => {
        if (command.includes("telegram-login-qr.png")) {
          qrAttempt += 1;
          return { stderr: "", stdout: `tg://login?token=attempt-${qrAttempt}` };
        }
        if (command.includes("Telegram Desktop did not reach the main window")) {
          throw new Error("permission denied reading the remote Docker socket");
        }
        return { stderr: "", stdout: "" };
      }),
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
          leaseId: "cbx_borrowed",
          outputDir: "out",
          provider: "docker",
          recordFps: 24,
          ttl: "2h",
          userDriver: ["python3", "driver.py"],
        },
        operations,
      ),
    ).rejects.toThrow("permission denied reading the remote Docker socket");
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
    expect(scripts).toContain('test "$(cat /var/lib/crabbox/telegram-desktop-version)" = "7.0.9"');
    expect(scripts).toContain("DISPLAY=:99 xdpyinfo");
    expect(scripts).toContain("wmctrl xdotool scrot ffmpeg zbarimg xdpyinfo");
    expect(scripts.toLowerCase()).not.toMatch(/apt-get|curl|wget|tdlib|python/u);
    // -f patterns also match this script's own shell (its command line contains the
    // binary path), so a -f pkill kills the launcher instead of a stale Telegram.
    expect(scripts).toContain("pkill -x Telegram");
    expect(scripts).toContain("pgrep -x Telegram");
    expect(scripts).not.toMatch(/p(kill|grep) -f [^\n]*Telegram/u);
    // Container sshd tears down the session process group; the client must detach.
    expect(scripts).toContain("setsid /opt/Telegram/Telegram");
    // scrot exits 0 but keeps the existing file without -o, so repeated captures
    // would silently re-read the first screenshot.
    expect(scripts).not.toMatch(/scrot (?!-o)['"/]/u);
    expect(scripts).toContain("</dev/null");
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

describe("Telegram Desktop recorder window geometry", () => {
  it("parses the measured window and rejects unusable geometry", () => {
    expect(parseWindowGeometry(" 636 45 648 995 \n")).toEqual({
      height: 995,
      width: 648,
      x: 636,
      y: 45,
    });
    expect(() => parseWindowGeometry("636 45 648")).toThrow("was not readable");
    expect(() => parseWindowGeometry("636 45 10 10")).toThrow("too small to crop");
  });

  it("crops the recorded window instead of a fixed rectangle", async () => {
    const root = makeTempDir();
    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, {
      ...testSession(),
      window: { height: 995, width: 648, x: 636, y: 45 },
    });
    const cropped = vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 648 }));
    const operations = {
      createCroppedMotionPreview: cropped,
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => ({
        sshHost: "host",
        sshKey: "/tmp/key",
        sshPort: "22",
        sshUser: "user",
      })),
      runCommand: (async () => ({
        stderr: "",
        stdout: JSON.stringify({ ok: true }),
      })) as RunCommand,
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async () => ({ stderr: "", stdout: "" })),
    } satisfies RecorderOperations;

    await stopRecorder(
      root,
      { command: "stop", crop: "telegram-window", keepBox: false, sessionPath },
      operations,
    );
    expect(cropped).toHaveBeenCalledWith(
      expect.objectContaining({
        crop: { cropWidth: 648, height: 995, width: 648, x: 636, y: 45 },
      }),
    );
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

  it("never stops a borrowed --lease-id box, on failure or on stop", async () => {
    const root = makeTempDir();
    const calls: Array<{ args: string[]; command: string }> = [];
    const mockedRun: RunCommand = async (params) => {
      calls.push({ args: params.args, command: params.command });
      return { stderr: "", stdout: JSON.stringify({ ok: true }) };
    };
    const failingOperations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => {
        throw new Error("borrowed box unreachable");
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
          leaseId: "cbx_borrowed",
          outputDir: "out",
          provider: "aws",
          recordFps: 24,
          ttl: "2h",
          userDriver: ["python3", "driver.py"],
        },
        failingOperations,
      ),
    ).rejects.toThrow("borrowed box unreachable");
    expect(calls.some((call) => call.args[0] === "warmup")).toBe(false);
    expect(calls.some((call) => call.args[0] === "stop")).toBe(false);

    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, {
      ...testSession(),
      leaseId: "cbx_borrowed",
      leaseOwned: false,
    });
    const operations = {
      ...failingOperations,
      inspectCrabbox: vi.fn(async () => ({
        sshHost: "host",
        sshKey: "/tmp/key",
        sshPort: "22",
        sshUser: "user",
      })),
    } satisfies RecorderOperations;
    await stopRecorder(root, { command: "stop", keepBox: false, sessionPath }, operations);
    expect(calls.some((call) => call.args.includes("terminate-session"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "stop")).toBe(false);
  });

  it("keeps the Desktop authorization and the box alive with --keep-box", async () => {
    const root = makeTempDir();
    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, testSession());
    const calls: Array<{ args: string[]; command: string }> = [];
    const mockedRun: RunCommand = async (params) => {
      calls.push({ args: params.args, command: params.command });
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

    const stopped = await stopRecorder(
      root,
      { command: "stop", keepBox: true, sessionPath },
      operations,
    );
    expect(stopped.keepBox).toBe(true);
    expect(calls.some((call) => call.args.includes("terminate-session"))).toBe(false);
    expect(calls.some((call) => call.args[0] === "stop")).toBe(false);
  });

  it("uses the recorded provider for view, inspect, and owned-lease stop", async () => {
    const root = makeTempDir();
    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, {
      ...testSession(),
      imageSource: "openclaw-telegram-desktop:7.0.9",
      provider: "docker",
    });
    const calls: Array<{ args: string[]; command: string }> = [];
    const mockedRun: RunCommand = async (params) => {
      calls.push({ args: params.args, command: params.command });
      return { stderr: "", stdout: JSON.stringify({ ok: true }) };
    };
    const inspectCrabbox = vi.fn(async () => ({
      sshHost: "host",
      sshKey: "/tmp/key",
      sshPort: "22",
      sshUser: "user",
    }));
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 430 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox,
      runCommand: mockedRun,
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async () => ({ stderr: "", stdout: "" })),
    } satisfies RecorderOperations;

    await viewRecorder(root, { command: "view", messageId: "42", sessionPath }, operations);
    await stopRecorder(root, { command: "stop", keepBox: false, sessionPath }, operations);

    expect(inspectCrabbox).toHaveBeenCalledTimes(2);
    expect(inspectCrabbox).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "docker" }),
    );
    expect(inspectCrabbox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "docker" }),
    );
    expect(calls).toContainEqual({
      args: ["stop", "--provider", "docker", "cbx_test123"],
      command: "crabbox",
    });
  });

  it("finishes cleanly without previews when the lease is already gone", async () => {
    const root = makeTempDir();
    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, testSession());
    const preview = vi.fn(async () => ({}));
    const cropped = vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 650 }));
    const operations = {
      createCroppedMotionPreview: cropped,
      createMotionPreview: preview,
      inspectCrabbox: vi.fn(async () => {
        throw new Error("local-container lease not found: cbx_test123");
      }),
      runCommand: (async () => ({
        stderr: "",
        stdout: JSON.stringify({ ok: true }),
      })) as RunCommand,
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async () => ({ stderr: "", stdout: "" })),
    } satisfies RecorderOperations;

    const stopped = await stopRecorder(
      root,
      { command: "stop", crop: "telegram-window", keepBox: false, sessionPath },
      operations,
    );
    expect(stopped.cleanupErrors).toBeUndefined();
    expect(preview).not.toHaveBeenCalled();
    expect(cropped).not.toHaveBeenCalled();
  });

  it("keeps artifacts recorded by an earlier keep-box stop", async () => {
    const root = makeTempDir();
    const sessionPath = path.join(root, "recorder.json");
    writeRecorderSession(sessionPath, {
      ...testSession(),
      artifacts: { previewGif: "/kept/motion.gif", video: "/kept/session.mp4" },
      keepBox: true,
    });
    const operations = {
      createCroppedMotionPreview: vi.fn(async () => ({ crop: "", fps: 24, outputWidth: 650 })),
      createMotionPreview: vi.fn(async () => ({})),
      inspectCrabbox: vi.fn(async () => {
        throw new Error("local-container lease not found: cbx_test123");
      }),
      runCommand: (async () => ({
        stderr: "",
        stdout: JSON.stringify({ ok: true }),
      })) as RunCommand,
      scpFromRemote: vi.fn(async () => undefined),
      sshRun: vi.fn(async () => ({ stderr: "", stdout: "" })),
    } satisfies RecorderOperations;

    const stopped = await stopRecorder(
      root,
      { command: "stop", keepBox: false, sessionPath },
      operations,
    );
    expect(stopped.artifacts).toEqual({
      previewGif: "/kept/motion.gif",
      video: "/kept/session.mp4",
    });
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
