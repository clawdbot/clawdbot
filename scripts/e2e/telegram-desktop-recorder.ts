#!/usr/bin/env -S node --import tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { coerceErrorMessage } from "../lib/error-format.mts";
import { sleep } from "../lib/sleep.mjs";
import {
  createCroppedMotionPreview,
  createDesktopCrabboxWarmupArgs,
  createMotionPreview,
  extractCrabboxLeaseId,
  inspectCrabbox,
  type CrabboxInspect,
  type RunCommand,
  renderStartRemoteRecording,
  renderStopRemoteRecording,
  renderTelegramViewCommand,
  runCommand,
  scpFromRemote,
  shellQuote,
  sshRun,
  TELEGRAM_DESKTOP_CROP,
  telegramPrivatePostLink,
} from "./telegram-desktop-crabbox.ts";
import {
  parseRecorderArgs,
  readRecorderSession,
  recorderUsageText,
  type RecorderProvider,
  type RecorderSession,
  type ScreenshotOptions,
  type StartOptions,
  type StatusOptions,
  type StopOptions,
  type ViewOptions,
  writeRecorderSession,
} from "./telegram-desktop-recorder-contract.ts";

export {
  parseRecorderArgs,
  readRecorderSession,
  type RecorderSession,
  recorderUsageText,
  writeRecorderSession,
} from "./telegram-desktop-recorder-contract.ts";

const REMOTE_ROOT = "/tmp/openclaw-telegram-desktop-recorder";
const TELEGRAM_BINARY = "/opt/Telegram/Telegram";
// Crabbox variant image baked with CRABBOX_LINUX_TELEGRAM_DESKTOP=1 and promoted
// catalog-only; the generic desktop image never carries the client, so the lease
// must ask for it or Crabbox fails before leasing.
const TELEGRAM_DESKTOP_VERSION = "7.0.9";
const TELEGRAM_IMAGE_SDK = `telegram-desktop=${TELEGRAM_DESKTOP_VERSION}`;
const TELEGRAM_WORKDIR = `${REMOTE_ROOT}/desktop`;
const DEFAULT_PREVIEW_FPS = 24;
const DEFAULT_PREVIEW_WIDTH = 1920;

const remotePaths = {
  desktopLog: `${REMOTE_ROOT}/telegram-desktop.log`,
  ffmpegLog: `${REMOTE_ROOT}/ffmpeg.log`,
  ffmpegPid: `${REMOTE_ROOT}/ffmpeg.pid`,
  finalScreenshot: `${REMOTE_ROOT}/final.png`,
  video: `${REMOTE_ROOT}/session.mp4`,
} as const;

const confirmedQrSchema = z.object({
  ok: z.literal(true),
  session: z.object({
    id: z.union([z.string(), z.number()]),
    isPasswordPending: z.boolean().nullish(),
  }),
});

export type RecorderOperations = {
  createCroppedMotionPreview: typeof createCroppedMotionPreview;
  createMotionPreview: typeof createMotionPreview;
  inspectCrabbox: typeof inspectCrabbox;
  runCommand: RunCommand;
  scpFromRemote: typeof scpFromRemote;
  sshRun: typeof sshRun;
};

const defaultOperations: RecorderOperations = {
  createCroppedMotionPreview,
  createMotionPreview,
  inspectCrabbox,
  runCommand,
  scpFromRemote,
  sshRun,
};

export function renderGoldenImagePreflight(): string {
  return `set -euo pipefail
contract="Telegram Desktop recorder golden image contract"
fail() { echo "$contract failed: $1" >&2; exit 1; }
test -x ${TELEGRAM_BINARY} || fail "${TELEGRAM_BINARY} is not executable"
test "$(cat /var/lib/crabbox/telegram-desktop-version 2>/dev/null)" = "${TELEGRAM_DESKTOP_VERSION}" || fail "/var/lib/crabbox/telegram-desktop-version is not ${TELEGRAM_DESKTOP_VERSION}"
for command in wmctrl xdotool scrot ffmpeg zbarimg xdpyinfo; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is not on PATH"
done
DISPLAY=:99 xdpyinfo >/dev/null 2>&1 || fail "DISPLAY=:99 is unreachable"`;
}

export function renderLaunchDesktop(): string {
  return `set -euo pipefail
export DISPLAY=:99
root=${REMOTE_ROOT}
mkdir -p "$root"
pkill -f '${TELEGRAM_BINARY}.*${TELEGRAM_WORKDIR}' >/dev/null 2>&1 || true
rm -rf ${shellQuote(TELEGRAM_WORKDIR)}
nohup ${TELEGRAM_BINARY} -noupdate -workdir ${shellQuote(TELEGRAM_WORKDIR)} >${shellQuote(remotePaths.desktopLog)} 2>&1 &
pid=$!
for _ in $(seq 1 30); do
  kill -0 "$pid" >/dev/null 2>&1 || { tail -c 262144 ${shellQuote(remotePaths.desktopLog)} >&2 || true; exit 1; }
  wmctrl -lx | awk 'tolower($0) ~ /telegramdesktop/ {found=1} END {exit !found}' && exit 0
  sleep 1
done
tail -c 262144 ${shellQuote(remotePaths.desktopLog)} >&2 || true
echo "Telegram Desktop window did not open." >&2
exit 1`;
}

export function renderPrepareQr(): string {
  return `set -euo pipefail
export DISPLAY=:99
win="$(wmctrl -l | awk 'tolower($0) ~ /telegram/ {print $1; exit}')"
test -n "$win"
click_window_ratio() {
  eval "$(xdotool getwindowgeometry --shell "$win")"
  xdotool windowactivate "$win"
  sleep 0.2
  xdotool mousemove "$((X + WIDTH / 2))" "$((Y + HEIGHT * $1 / 100))"
  sleep 0.2
  xdotool click 1
  sleep 1
}
click_window_ratio 69
sleep 3
click_window_ratio 80`;
}

export function renderReadQrLink(): string {
  return `set -euo pipefail
export DISPLAY=:99
scrot ${shellQuote(`${REMOTE_ROOT}/telegram-login-qr.png`)}
zbarimg --raw ${shellQuote(`${REMOTE_ROOT}/telegram-login-qr.png`)} 2>/dev/null | awk 'index($0, "tg://login?token=") == 1 {print; found=1; exit} END {exit !found}'`;
}

export function renderWaitForMainWindow(): string {
  return `set -euo pipefail
export DISPLAY=:99
for _ in $(seq 1 30); do
  win="$(wmctrl -lx | awk 'tolower($0) ~ /telegramdesktop/ {print $1; exit}')"
  if [ -n "$win" ]; then
    scrot ${shellQuote(`${REMOTE_ROOT}/telegram-main-window.png`)}
    if ! zbarimg --raw ${shellQuote(`${REMOTE_ROOT}/telegram-main-window.png`)} 2>/dev/null | grep -q '^tg://login?token='; then
      exit 0
    fi
  fi
  sleep 1
done
echo "Telegram Desktop did not reach the main window." >&2
exit 1`;
}

function driverCommand(userDriver: string[], args: string[]) {
  const [command, ...prefixArgs] = userDriver;
  if (!command) {
    throw new Error("User driver command is empty.");
  }
  return { args: [...prefixArgs, ...args], command };
}

export async function confirmQrLink(params: {
  cwd: string;
  link: string;
  run?: RunCommand;
  userDriver: string[];
}): Promise<string> {
  const command = driverCommand(params.userDriver, ["confirm-qr", "--link", params.link, "--json"]);
  const result = await (params.run ?? runCommand)({
    ...command,
    cwd: params.cwd,
    redactValues: [params.link],
  });
  const confirmed = confirmedQrSchema.parse(JSON.parse(result.stdout));
  if (confirmed.session.isPasswordPending) {
    throw new Error("Telegram Desktop QR login requires a 2FA password.");
  }
  return String(confirmed.session.id);
}

async function authorizeDesktop(params: {
  cwd: string;
  inspect: CrabboxInspect;
  operations: RecorderOperations;
  userDriver: string[];
}): Promise<string> {
  await params.operations.sshRun({
    command: renderPrepareQr(),
    cwd: params.cwd,
    inspect: params.inspect,
    run: params.operations.runCommand,
  });
  let lastLink = "";
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    try {
      const qr = await params.operations.sshRun({
        command: renderReadQrLink(),
        cwd: params.cwd,
        inspect: params.inspect,
        run: params.operations.runCommand,
        stdio: "pipe",
      });
      const link = qr.stdout.trim();
      if (!link || link === lastLink) {
        await sleep(1000);
        continue;
      }
      lastLink = link;
      const desktopSessionId = await confirmQrLink({
        cwd: params.cwd,
        link,
        run: params.operations.runCommand,
        userDriver: params.userDriver,
      });
      return desktopSessionId;
    } catch (error) {
      if (coerceErrorMessage(error).includes("requires a 2FA password")) {
        throw error;
      }
      await sleep(1000);
    }
  }
  throw new Error("Telegram Desktop QR authorization failed after 25 rotated-token attempts.");
}

function resolveOutputDir(cwd: string, outputDir: string): string {
  if (path.isAbsolute(outputDir)) {
    throw new Error("--output-dir must be repo-relative.");
  }
  const resolved = path.resolve(cwd, outputDir);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output-dir must stay inside the repository.");
  }
  return resolved;
}

async function stopBox(params: {
  crabboxBin: string;
  cwd: string;
  leaseId: string;
  provider: RecorderProvider;
  run: RunCommand;
}): Promise<void> {
  await params.run({
    args: ["stop", "--provider", params.provider, params.leaseId],
    command: params.crabboxBin,
    cwd: params.cwd,
    stdio: "inherit",
  });
}

async function terminateDesktopSession(params: {
  cwd: string;
  desktopSessionId: string;
  run: RunCommand;
  userDriver: string[];
}): Promise<void> {
  const command = driverCommand(params.userDriver, [
    "terminate-session",
    "--session-id",
    params.desktopSessionId,
    "--json",
  ]);
  const result = await params.run({ ...command, cwd: params.cwd });
  z.object({ ok: z.literal(true) }).parse(JSON.parse(result.stdout));
}

export async function startRecorder(
  cwd: string,
  opts: StartOptions,
  operations: RecorderOperations = defaultOperations,
): Promise<{ session: RecorderSession; sessionPath: string }> {
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const outputDir = resolveOutputDir(cwd, opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  let leaseId = opts.leaseId;
  const leaseOwned = !opts.leaseId;
  let desktopSessionId: string | undefined;
  try {
    if (!leaseId) {
      const warmup = await operations.runCommand({
        args: createDesktopCrabboxWarmupArgs({
          crabboxClass: opts.crabboxClass,
          idleTimeout: opts.idleTimeout,
          imageSdk: TELEGRAM_IMAGE_SDK,
          provider: opts.provider,
          ttl: opts.ttl,
        }),
        command: crabboxBin,
        cwd,
        stdio: "inherit",
      });
      leaseId = extractCrabboxLeaseId(`${warmup.stdout}\n${warmup.stderr}`);
      if (!leaseId) {
        throw new Error("Crabbox warmup did not print a lease id.");
      }
    }
    const inspect = await operations.inspectCrabbox({
      crabboxBin,
      cwd,
      leaseId,
      provider: opts.provider,
      run: operations.runCommand,
    });
    await operations.sshRun({
      command: renderGoldenImagePreflight(),
      cwd,
      inspect,
      run: operations.runCommand,
    });
    await operations.sshRun({
      command: renderLaunchDesktop(),
      cwd,
      inspect,
      run: operations.runCommand,
    });
    desktopSessionId = await authorizeDesktop({
      cwd,
      inspect,
      operations,
      userDriver: opts.userDriver,
    });
    await operations.sshRun({
      command: renderWaitForMainWindow(),
      cwd,
      inspect,
      run: operations.runCommand,
    });
    const link = opts.messageId ? telegramPrivatePostLink(opts.chat, opts.messageId) : undefined;
    await operations.sshRun({
      command: renderTelegramViewCommand({
        binary: TELEGRAM_BINARY,
        link,
        workdir: TELEGRAM_WORKDIR,
      }),
      cwd,
      inspect,
      run: operations.runCommand,
    });
    await operations.sshRun({
      command: renderStartRemoteRecording({ paths: remotePaths, recordFps: opts.recordFps }),
      cwd,
      inspect,
      run: operations.runCommand,
    });
    const session: RecorderSession = {
      chat: opts.chat,
      desktopSessionId,
      keepBox: false,
      leaseId,
      leaseOwned,
      provider: opts.provider,
      recordFps: opts.recordFps,
      remotePaths,
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      userDriver: opts.userDriver,
    };
    const sessionPath = path.join(outputDir, "recorder.json");
    writeRecorderSession(sessionPath, session);
    return { session, sessionPath };
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (desktopSessionId) {
      await terminateDesktopSession({
        cwd,
        desktopSessionId,
        run: operations.runCommand,
        userDriver: opts.userDriver,
      }).catch((cleanupError: unknown) => cleanupErrors.push(coerceErrorMessage(cleanupError)));
    }
    if (leaseId && leaseOwned) {
      await stopBox({
        crabboxBin,
        cwd,
        leaseId,
        provider: opts.provider,
        run: operations.runCommand,
      }).catch((cleanupError: unknown) => cleanupErrors.push(coerceErrorMessage(cleanupError)));
    }
    const suffix = cleanupErrors.length ? ` Cleanup also failed: ${cleanupErrors.join("; ")}` : "";
    throw new Error(`${coerceErrorMessage(error)}${suffix}`, { cause: error });
  }
}

async function sessionInspect(params: {
  crabboxBin: string;
  cwd: string;
  operations: RecorderOperations;
  session: RecorderSession;
}): Promise<CrabboxInspect> {
  return await params.operations.inspectCrabbox({
    crabboxBin: params.crabboxBin,
    cwd: params.cwd,
    leaseId: params.session.leaseId,
    provider: params.session.provider,
    run: params.operations.runCommand,
  });
}

export async function viewRecorder(
  cwd: string,
  opts: ViewOptions,
  operations: RecorderOperations = defaultOperations,
): Promise<void> {
  const session = readRecorderSession(opts.sessionPath);
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const inspect = await sessionInspect({ crabboxBin, cwd, operations, session });
  await operations.sshRun({
    command: renderTelegramViewCommand({
      binary: TELEGRAM_BINARY,
      link: telegramPrivatePostLink(session.chat, opts.messageId),
      workdir: TELEGRAM_WORKDIR,
    }),
    cwd,
    inspect,
    run: operations.runCommand,
  });
}

async function captureScreenshot(params: {
  cwd: string;
  inspect: CrabboxInspect;
  localPath: string;
  operations: RecorderOperations;
  remotePath: string;
}): Promise<void> {
  await params.operations.sshRun({
    command: `set -euo pipefail\nDISPLAY=:99 scrot ${shellQuote(params.remotePath)}`,
    cwd: params.cwd,
    inspect: params.inspect,
    run: params.operations.runCommand,
  });
  await params.operations.scpFromRemote({
    cwd: params.cwd,
    inspect: params.inspect,
    local: params.localPath,
    remote: params.remotePath,
    run: params.operations.runCommand,
  });
}

export async function screenshotRecorder(
  cwd: string,
  opts: ScreenshotOptions,
  operations: RecorderOperations = defaultOperations,
): Promise<string> {
  const session = readRecorderSession(opts.sessionPath);
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const inspect = await sessionInspect({ crabboxBin, cwd, operations, session });
  const output =
    opts.output ??
    path.join(
      path.dirname(opts.sessionPath),
      `telegram-desktop-recorder-screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`,
    );
  await captureScreenshot({
    cwd,
    inspect,
    localPath: path.resolve(cwd, output),
    operations,
    remotePath: `${REMOTE_ROOT}/screenshot.png`,
  });
  return path.resolve(cwd, output);
}

export async function stopRecorder(
  cwd: string,
  opts: StopOptions,
  operations: RecorderOperations = defaultOperations,
): Promise<RecorderSession> {
  const session = readRecorderSession(opts.sessionPath);
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const outputDir = path.dirname(path.resolve(cwd, opts.sessionPath));
  const errors: string[] = [];
  const artifacts: Record<string, string> = {};
  const attempt = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}: ${coerceErrorMessage(error)}`);
    }
  };
  let inspect: CrabboxInspect | undefined;
  await attempt("inspect", async () => {
    inspect = await sessionInspect({ crabboxBin, cwd, operations, session });
  });
  const videoPath = path.join(outputDir, "telegram-desktop-recorder-session.mp4");
  const desktopLogPath = path.join(outputDir, "telegram-desktop.log");
  const ffmpegLogPath = path.join(outputDir, "ffmpeg.log");
  const screenshotPath = path.join(outputDir, "telegram-desktop-recorder-session.png");
  const activeInspect = inspect;
  if (activeInspect) {
    await attempt("stop recording", async () => {
      await operations.sshRun({
        command: renderStopRemoteRecording(session.remotePaths.ffmpegPid),
        cwd,
        inspect: activeInspect,
        run: operations.runCommand,
      });
    });
    for (const [label, artifactKey, remote, local] of [
      ["copy video", "video", session.remotePaths.video, videoPath],
      ["copy Telegram Desktop log", "desktopLog", session.remotePaths.desktopLog, desktopLogPath],
      ["copy ffmpeg log", "ffmpegLog", session.remotePaths.ffmpegLog, ffmpegLogPath],
    ] as const) {
      await attempt(label, async () => {
        await operations.scpFromRemote({
          cwd,
          inspect: activeInspect,
          local,
          remote,
          run: operations.runCommand,
        });
        artifacts[artifactKey] = local;
      });
    }
    await attempt("final screenshot", async () => {
      await captureScreenshot({
        cwd,
        inspect: activeInspect,
        localPath: screenshotPath,
        operations,
        remotePath: session.remotePaths.finalScreenshot,
      });
      artifacts.screenshot = screenshotPath;
    });
  }
  const motionVideoPath = path.join(outputDir, "telegram-desktop-recorder-session-motion.mp4");
  const motionGifPath = path.join(outputDir, "telegram-desktop-recorder-session-motion.gif");
  await attempt("motion preview", async () => {
    await operations.createMotionPreview({
      crabboxBin,
      cwd,
      fps: DEFAULT_PREVIEW_FPS,
      gifPath: motionGifPath,
      run: operations.runCommand,
      trimmedVideoPath: motionVideoPath,
      videoPath,
      width: DEFAULT_PREVIEW_WIDTH,
    });
    artifacts.previewGif = motionGifPath;
    artifacts.trimmedVideo = motionVideoPath;
  });
  if (opts.crop === "telegram-window") {
    const croppedVideoPath = path.join(
      outputDir,
      "telegram-desktop-recorder-session-motion-telegram-window.mp4",
    );
    const croppedGifPath = path.join(
      outputDir,
      "telegram-desktop-recorder-session-motion-telegram-window.gif",
    );
    await attempt("cropped motion preview", async () => {
      await operations.createCroppedMotionPreview({
        crop: TELEGRAM_DESKTOP_CROP,
        croppedGifPath,
        croppedVideoPath,
        cwd,
        fps: DEFAULT_PREVIEW_FPS,
        run: operations.runCommand,
        videoPath: motionVideoPath,
      });
      artifacts.previewGifCropped = croppedGifPath;
      artifacts.trimmedVideoCropped = croppedVideoPath;
    });
  }
  // --keep-box keeps the whole debugging surface: the Desktop authorization stays
  // valid for WebVNC until the operator finishes; a later `stop` without it revokes.
  if (!opts.keepBox) {
    await attempt("terminate Telegram Desktop session", async () => {
      await terminateDesktopSession({
        cwd,
        desktopSessionId: session.desktopSessionId,
        run: operations.runCommand,
        userDriver: session.userDriver,
      });
    });
  }
  if (!opts.keepBox && session.leaseOwned) {
    await attempt("stop Crabbox", async () => {
      await stopBox({
        crabboxBin,
        cwd,
        leaseId: session.leaseId,
        provider: session.provider,
        run: operations.runCommand,
      });
    });
  }
  const stopped: RecorderSession = {
    ...session,
    artifacts,
    cleanupErrors: errors.length ? errors : undefined,
    keepBox: opts.keepBox,
    stoppedAt: new Date().toISOString(),
  };
  writeRecorderSession(opts.sessionPath, stopped);
  if (errors.length) {
    throw new Error(`Recorder stop completed with errors:\n${errors.join("\n")}`);
  }
  return stopped;
}

async function statusRecorder(
  cwd: string,
  opts: StatusOptions,
  operations: RecorderOperations,
): Promise<Record<string, unknown>> {
  const session = readRecorderSession(opts.sessionPath);
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const inspect = await sessionInspect({ crabboxBin, cwd, operations, session });
  return {
    inspect,
    webvnc: `${crabboxBin} webvnc --provider ${session.provider} --target linux --id ${session.leaseId} --open`,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(recorderUsageText());
    return;
  }
  const opts = parseRecorderArgs(args);
  const cwd = process.cwd();
  if (opts.command === "start") {
    const result = await startRecorder(cwd, opts);
    console.log(
      opts.json
        ? JSON.stringify(result.session, null, 2)
        : `Recorder started: ${path.relative(cwd, result.sessionPath)}`,
    );
    return;
  }
  if (opts.command === "view") {
    await viewRecorder(cwd, opts);
    console.log(`Telegram Desktop opened message ${opts.messageId}.`);
    return;
  }
  if (opts.command === "screenshot") {
    console.log(await screenshotRecorder(cwd, opts));
    return;
  }
  if (opts.command === "stop") {
    console.log(JSON.stringify(await stopRecorder(cwd, opts), null, 2));
    return;
  }
  console.log(JSON.stringify(await statusRecorder(cwd, opts, defaultOperations), null, 2));
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
  );
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(coerceErrorMessage(error));
    process.exitCode = 1;
  });
}
