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
  telegramPrivatePostLink,
} from "./telegram-desktop-crabbox.ts";
import {
  parseRecorderArgs,
  readRecorderSession,
  type ArtifactsOptions,
  type RecoverOptions,
  recorderUsageText,
  TELEGRAM_DESKTOP_AWS_IMAGE,
  TELEGRAM_DESKTOP_DOCKER_IMAGE,
  TELEGRAM_DESKTOP_VERSION,
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
const TELEGRAM_WORKDIR = `${REMOTE_ROOT}/desktop`;
const DEFAULT_PREVIEW_FPS = 4;
const PROOF_VIEWPORT_HEIGHT = 600;

function proofViewport(window: RecorderSession["window"]): {
  cropWidth: number;
  height: number;
  width: number;
  x: number;
  y: number;
} {
  const height = Math.min(PROOF_VIEWPORT_HEIGHT, window.height);
  return {
    cropWidth: window.width,
    height,
    width: window.width,
    x: window.x,
    y: window.y + window.height - height,
  };
}

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

class FreshDesktopRequiredError extends Error {}

const recorderStartupSchema = z.object({
  desktopSessionId: z.string().min(1).optional(),
  leaseId: z.string().min(1).optional(),
  leaseOwned: z.boolean(),
  provider: z.enum(["aws", "docker"]),
  schemaVersion: z.literal(1),
  userDriver: z.array(z.string()).min(1),
});
type RecorderStartup = z.infer<typeof recorderStartupSchema>;

function recorderStartupPath(sessionPath: string): string {
  return `${sessionPath}.starting`;
}

function writeRecorderStartup(file: string, startup: RecorderStartup, exclusive = false): void {
  const parsed = recorderStartupSchema.parse(startup);
  if (exclusive) {
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

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
test "$(cat /var/lib/crabbox/telegram-desktop-version)" = "${TELEGRAM_DESKTOP_VERSION}" || fail "/var/lib/crabbox/telegram-desktop-version is not ${TELEGRAM_DESKTOP_VERSION}"
for command in wmctrl xdotool scrot ffmpeg zbarimg xdpyinfo; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is not on PATH"
done
DISPLAY=:99 xdpyinfo >/dev/null || fail "DISPLAY=:99 is unreachable"`;
}

export function renderLaunchDesktop(): string {
  return `set -euo pipefail
export DISPLAY=:99
root=${REMOTE_ROOT}
mkdir -p "$root"
# Match the process name exactly: -f patterns also match this script's own shell,
# whose command line contains these paths, so pkill -f would kill the launcher.
pkill -x Telegram >/dev/null 2>&1 || true
rm -rf ${shellQuote(TELEGRAM_WORKDIR)}
# setsid plus closed stdin detaches Telegram from this SSH session: container sshd
# tears down the session process group on exit, which kills a plain background child.
setsid ${TELEGRAM_BINARY} -noupdate -workdir ${shellQuote(TELEGRAM_WORKDIR)} </dev/null >${shellQuote(remotePaths.desktopLog)} 2>&1 &
for _ in $(seq 1 30); do
  pgrep -x Telegram >/dev/null 2>&1 || { tail -c 262144 ${shellQuote(remotePaths.desktopLog)} >&2 || true; echo "Telegram Desktop exited before opening a window." >&2; exit 1; }
  wmctrl -lx | awk 'tolower($0) ~ /telegramdesktop/ {found=1} END {exit !found}' && exit 0
  sleep 1
done
tail -c 262144 ${shellQuote(remotePaths.desktopLog)} >&2 || true
echo "Telegram Desktop window did not open." >&2
exit 1`;
}

export function renderReadWindowGeometry(): string {
  return `set -euo pipefail
export DISPLAY=:99
win="$(wmctrl -lx | awk 'tolower($0) ~ /telegramdesktop/ {print $1; exit}')"
test -n "$win"
eval "$(xdotool getwindowgeometry --shell "$win")"
printf '%s %s %s %s\n' "$X" "$Y" "$WIDTH" "$HEIGHT"`;
}

function renderHideTelegramWindow(): string {
  return `set -euo pipefail
export DISPLAY=:99
win="$(wmctrl -lx | awk 'tolower($0) ~ /telegramdesktop/ {print $1; exit}')"
test -n "$win"
xdotool windowminimize "$win"
sleep 0.2`;
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
# -o is required: scrot exits 0 but silently keeps the existing file otherwise,
# so every later capture would re-read the first screenshot.
scrot -o ${shellQuote(`${REMOTE_ROOT}/telegram-login-qr.png`)}
zbarimg --raw ${shellQuote(`${REMOTE_ROOT}/telegram-login-qr.png`)} | awk 'index($0, "tg://login?token=") == 1 {print; found=1; exit} END {exit !found}'`;
}

export function renderWaitForMainWindow(seconds = 30): string {
  return `set -euo pipefail
export DISPLAY=:99
for _ in $(seq 1 ${seconds}); do
  win="$(wmctrl -lx | awk 'tolower($0) ~ /telegramdesktop/ {print $1; exit}')"
  if [ -n "$win" ]; then
    scrot -o ${shellQuote(`${REMOTE_ROOT}/telegram-main-window.png`)}
    # No decodable QR is the success signal here, so zbarimg's "not detected" complaint would
    # make every healthy wait read as a failure. renderReadQrLink keeps its stderr, where a
    # failed decode is the reported problem.
    if ! zbarimg --raw ${shellQuote(`${REMOTE_ROOT}/telegram-main-window.png`)} 2>/dev/null | grep -q '^tg://login?token='; then
      exit 0
    fi
  fi
  sleep 1
done
echo "Telegram Desktop did not reach the main window." >&2
exit 1`;
}

export function parseWindowGeometry(raw: string): {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  const parts = raw.trim().split(/\s+/u).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Telegram Desktop window geometry was not readable: ${raw.trim()}`);
  }
  const [x, y, width, height] = parts as [number, number, number, number];
  if (width < 200 || height < 200) {
    throw new Error(`Telegram Desktop window is too small to crop: ${width}x${height}`);
  }
  return { height, width, x, y };
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
  onSessionConfirmed?: (desktopSessionId: string) => void;
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
  const desktopSessionId = String(confirmed.session.id);
  params.onSessionConfirmed?.(desktopSessionId);
  if (confirmed.session.isPasswordPending) {
    throw new Error("Telegram Desktop QR login requires a 2FA password.");
  }
  return desktopSessionId;
}

async function desktopReachedMainWindow(params: {
  cwd: string;
  inspect: CrabboxInspect;
  operations: RecorderOperations;
  seconds: number;
}): Promise<{ reached: true } | { error: unknown; reached: false }> {
  try {
    await params.operations.sshRun({
      command: renderWaitForMainWindow(params.seconds),
      cwd: params.cwd,
      inspect: params.inspect,
      run: params.operations.runCommand,
    });
    return { reached: true };
  } catch (error) {
    return { error, reached: false };
  }
}

async function authorizeDesktop(params: {
  cwd: string;
  inspect: CrabboxInspect;
  onDesktopSessionChanged: (desktopSessionId: string | undefined) => void;
  operations: RecorderOperations;
  outputDir: string;
  userDriver: string[];
}): Promise<string> {
  await params.operations.sshRun({
    command: renderPrepareQr(),
    cwd: params.cwd,
    inspect: params.inspect,
    run: params.operations.runCommand,
  });
  // Telegram rotates the login token roughly every 30s and silently ignores a
  // confirmation for a rotated one, so a confirmed session id is not proof of
  // login: read a fresh code, confirm it, then verify the client left the QR
  // screen before trusting it.
  // The loop can end for reasons it never observed - a QR read that threw, a duplicate
  // link, a window wait that timed out - so carry the last real failure into the throw
  // instead of asserting the client stayed on the login screen.
  let lastFailure: unknown;
  let lastLink = "";
  let acceptedWithoutTransition = 0;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    let link: string;
    try {
      const qr = await params.operations.sshRun({
        command: renderReadQrLink(),
        cwd: params.cwd,
        inspect: params.inspect,
        run: params.operations.runCommand,
        stdio: "pipe",
      });
      link = qr.stdout.trim();
    } catch (error) {
      lastFailure = error;
      link = "";
    }
    if (!link || link === lastLink) {
      await sleep(2000);
      continue;
    }
    lastLink = link;
    const desktopSessionId = await confirmQrLink({
      cwd: params.cwd,
      link,
      onSessionConfirmed: params.onDesktopSessionChanged,
      run: params.operations.runCommand,
      userDriver: params.userDriver,
    });
    const mainWindow = await desktopReachedMainWindow({
      cwd: params.cwd,
      inspect: params.inspect,
      operations: params.operations,
      seconds: 20,
    });
    if (mainWindow.reached) {
      return desktopSessionId;
    }
    lastFailure = mainWindow.error;
    acceptedWithoutTransition += 1;
    await terminateDesktopSession({
      cwd: params.cwd,
      desktopSessionId,
      run: params.operations.runCommand,
      userDriver: params.userDriver,
    });
    params.onDesktopSessionChanged(undefined);
    // Observed 2026-08 in run 32330408746: one client ignored six server-accepted
    // tokens for 138s; a fresh container accepted its first. A second accepted token
    // distinguishes that wedged client from the ordinary rotating-token race.
    if (acceptedWithoutTransition >= 2) {
      break;
    }
  }
  const detail = lastFailure === undefined ? "" : `: ${coerceErrorMessage(lastFailure)}`;
  // The screen the QR read could not decode is the only thing that separates "Telegram
  // never rendered the code" from "the code was there and zbarimg missed it", so it has to
  // leave the container. Reporting the fetch outcome keeps a failed fetch from reading as
  // an absent screenshot.
  const evidencePath = path.join(params.outputDir, "telegram-login-screen.png");
  let evidence: string;
  try {
    await params.operations.scpFromRemote({
      cwd: params.cwd,
      inspect: params.inspect,
      local: evidencePath,
      remote: `${REMOTE_ROOT}/telegram-login-qr.png`,
      run: params.operations.runCommand,
    });
    evidence = ` Login screen: ${evidencePath}`;
  } catch (error) {
    evidence = ` Login screen could not be fetched: ${coerceErrorMessage(error)}`;
  }
  const message =
    acceptedWithoutTransition >= 2
      ? `Telegram server accepted ${acceptedWithoutTransition} login tokens, but Telegram Desktop stayed on the QR screen${detail}.${evidence}`
      : `Telegram Desktop did not leave the login screen after 6 attempts${detail}.${evidence}`;
  if (acceptedWithoutTransition >= 2) {
    throw new FreshDesktopRequiredError(message, { cause: lastFailure });
  }
  throw new Error(message, { cause: lastFailure });
}

// The recorder runs as a different user than the agent that drives it, so an output dir
// the agent owns can be unwritable here. The first write is the session file, minutes after
// provisioning, so probe up front and report who is blocked rather than failing at the end.
function assertOutputDirWritable(outputDir: string): void {
  const probe = path.join(outputDir, `.recorder-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (error) {
    const stats = fs.statSync(outputDir);
    const mode = (stats.mode & 0o7777).toString(8).padStart(4, "0");
    throw new Error(
      `Cannot write recorder output to ${outputDir}: ${coerceErrorMessage(error)}. ` +
        `Directory is uid=${stats.uid} gid=${stats.gid} mode=${mode}; ` +
        `recorder runs as uid=${process.getuid?.()} gid=${process.getgid?.()}.`,
      { cause: error },
    );
  }
}

function resolveRecorderPath(cwd: string, supplied: string, option: string): string {
  if (path.isAbsolute(supplied)) {
    throw new Error(`${option} must be relative.`);
  }
  const resolved = path.resolve(cwd, supplied);
  const relative = path.relative(cwd, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${option} must stay inside the recorder root.`);
  }
  return resolved;
}

function resolveOutputDir(cwd: string, outputDir: string): string {
  return resolveRecorderPath(cwd, outputDir, "--output-dir");
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

async function terminateDesktopSessions(params: {
  cwd: string;
  run: RunCommand;
  userDriver: string[];
}): Promise<void> {
  const command = driverCommand(params.userDriver, ["terminate-desktop-sessions", "--json"]);
  const result = await params.run({ ...command, cwd: params.cwd });
  z.object({ ok: z.literal(true) }).parse(JSON.parse(result.stdout));
}

async function assertLocalTelegramImage(params: { cwd: string; run: RunCommand }): Promise<void> {
  try {
    await params.run({
      args: ["image", "inspect", TELEGRAM_DESKTOP_DOCKER_IMAGE],
      command: "docker",
      cwd: params.cwd,
    });
  } catch (error) {
    throw new Error(
      // The CLI prints only `message`, so an inspect failure that is not a missing
      // image (an unreachable daemon, a denied socket) has to be readable here or the
      // operator is left with this wrapper's guess about the cause.
      `docker image inspect ${TELEGRAM_DESKTOP_DOCKER_IMAGE} failed: ${coerceErrorMessage(error)}. Build it with bash scripts/mantis/build-telegram-desktop-image.sh when the image is absent.`,
      { cause: error },
    );
  }
}

async function startRecorderAttempt(
  cwd: string,
  opts: StartOptions,
  operations: RecorderOperations,
  freshContainerAttempt: number,
): Promise<{ session: RecorderSession; sessionPath: string }> {
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const outputDir = resolveOutputDir(cwd, opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  assertOutputDirWritable(outputDir);
  const sessionPath = path.join(outputDir, "recorder.json");
  const startupPath = recorderStartupPath(sessionPath);
  let leaseId = opts.leaseId;
  const leaseOwned = !opts.leaseId;
  let desktopAuthorizationRequested = false;
  let desktopSessionId: string | undefined;
  const startup: RecorderStartup = {
    leaseId,
    leaseOwned,
    provider: opts.provider,
    schemaVersion: 1,
    userDriver: opts.userDriver,
  };
  // Provisioning crosses process and provider boundaries. Persist each acquired
  // handle so a later workflow step can reclaim it after cancellation or SIGKILL.
  writeRecorderStartup(startupPath, startup, freshContainerAttempt === 1);
  try {
    if (!leaseId) {
      if (opts.provider === "docker") {
        await assertLocalTelegramImage({ cwd, run: operations.runCommand });
      }
      const warmup = await operations.runCommand({
        args: createDesktopCrabboxWarmupArgs({
          crabboxClass: opts.crabboxClass,
          idleTimeout: opts.idleTimeout,
          imageSdk: opts.provider === "aws" ? TELEGRAM_DESKTOP_AWS_IMAGE : undefined,
          provider: opts.provider,
          ttl: opts.ttl,
        }),
        command: crabboxBin,
        cwd,
        env:
          opts.provider === "docker"
            ? { ...process.env, CRABBOX_LOCAL_CONTAINER_IMAGE: TELEGRAM_DESKTOP_DOCKER_IMAGE }
            : undefined,
        stdio: "inherit",
      });
      leaseId = extractCrabboxLeaseId(`${warmup.stdout}\n${warmup.stderr}`);
      if (!leaseId) {
        throw new Error("Crabbox warmup did not print a lease id.");
      }
      startup.leaseId = leaseId;
      writeRecorderStartup(startupPath, startup);
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
    desktopAuthorizationRequested = true;
    desktopSessionId = await authorizeDesktop({
      cwd,
      inspect,
      onDesktopSessionChanged: (sessionId) => {
        desktopSessionId = sessionId;
        startup.desktopSessionId = sessionId;
        writeRecorderStartup(startupPath, startup);
      },
      operations,
      outputDir,
      userDriver: opts.userDriver,
    });
    // Always open the target chat before recording: at the recorder's width Telegram shows
    // either the chat list or one conversation, and the list is the QA account's own.
    await operations.sshRun({
      command: renderTelegramViewCommand({
        binary: TELEGRAM_BINARY,
        link: telegramPrivatePostLink(opts.chat, opts.messageId),
        workdir: TELEGRAM_WORKDIR,
      }),
      cwd,
      inspect,
      run: operations.runCommand,
    });
    // Crop from the window Telegram actually got: window managers and providers
    // place it differently, and a fixed crop silently cuts the chat pane.
    const geometry = await operations.sshRun({
      command: renderReadWindowGeometry(),
      cwd,
      inspect,
      run: operations.runCommand,
      stdio: "pipe",
    });
    const windowGeometry = parseWindowGeometry(geometry.stdout);
    // The lane clears prior history before recorder start. Keep the empty chat hidden until
    // the first session-owned send is ready, so setup frames reveal neither account UI nor chat.
    await operations.sshRun({
      command: renderHideTelegramWindow(),
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
    const sessionBase: Omit<RecorderSession, "imageSource" | "provider"> = {
      chat: opts.chat,
      desktopSessionId,
      keepBox: false,
      leaseId,
      leaseOwned,
      recordFps: opts.recordFps,
      remotePaths,
      schemaVersion: 1,
      window: windowGeometry,
      startedAt: new Date().toISOString(),
      userDriver: opts.userDriver,
    };
    const session: RecorderSession =
      opts.provider === "docker"
        ? {
            ...sessionBase,
            imageSource: TELEGRAM_DESKTOP_DOCKER_IMAGE,
            provider: opts.provider,
          }
        : {
            ...sessionBase,
            imageSource: TELEGRAM_DESKTOP_AWS_IMAGE,
            provider: opts.provider,
          };
    writeRecorderSession(sessionPath, session);
    fs.rmSync(startupPath);
    return { session, sessionPath };
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (desktopAuthorizationRequested) {
      try {
        await terminateDesktopSessions({
          cwd,
          run: operations.runCommand,
          userDriver: opts.userDriver,
        });
        desktopSessionId = undefined;
        startup.desktopSessionId = undefined;
        writeRecorderStartup(startupPath, startup);
      } catch (cleanupError) {
        cleanupErrors.push(coerceErrorMessage(cleanupError));
      }
    }
    if (leaseId && leaseOwned) {
      try {
        await stopBox({
          crabboxBin,
          cwd,
          leaseId,
          provider: opts.provider,
          run: operations.runCommand,
        });
        startup.leaseId = undefined;
        writeRecorderStartup(startupPath, startup);
      } catch (cleanupError) {
        cleanupErrors.push(coerceErrorMessage(cleanupError));
      }
    }
    if (
      error instanceof FreshDesktopRequiredError &&
      cleanupErrors.length === 0 &&
      leaseOwned &&
      opts.provider === "docker" &&
      freshContainerAttempt === 1
    ) {
      return await startRecorderAttempt(cwd, opts, operations, freshContainerAttempt + 1);
    }
    if (cleanupErrors.length === 0) {
      fs.rmSync(startupPath, { force: true });
    }
    const suffix = cleanupErrors.length ? ` Cleanup also failed: ${cleanupErrors.join("; ")}` : "";
    throw new Error(`${coerceErrorMessage(error)}${suffix}`, { cause: error });
  }
}

export async function startRecorder(
  cwd: string,
  opts: StartOptions,
  operations: RecorderOperations = defaultOperations,
): Promise<{ session: RecorderSession; sessionPath: string }> {
  return await startRecorderAttempt(cwd, opts, operations, 1);
}

export async function recoverRecorderStartup(
  cwd: string,
  opts: RecoverOptions,
  operations: Pick<RecorderOperations, "runCommand"> = defaultOperations,
): Promise<{ recovered: boolean }> {
  const startupPath = recorderStartupPath(resolveRecorderPath(cwd, opts.sessionPath, "--session"));
  if (!fs.existsSync(startupPath)) {
    return { recovered: false };
  }
  const metadata = fs.lstatSync(startupPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Recorder startup state is not a regular file.");
  }
  const startup = recorderStartupSchema.parse(JSON.parse(fs.readFileSync(startupPath, "utf8")));
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const errors: string[] = [];
  try {
    await terminateDesktopSessions({
      cwd,
      run: operations.runCommand,
      userDriver: startup.userDriver,
    });
    startup.desktopSessionId = undefined;
    writeRecorderStartup(startupPath, startup);
  } catch (error) {
    errors.push(`terminate Telegram Desktop sessions: ${coerceErrorMessage(error)}`);
  }
  if (startup.leaseId && startup.leaseOwned) {
    try {
      await stopBox({
        crabboxBin,
        cwd,
        leaseId: startup.leaseId,
        provider: startup.provider,
        run: operations.runCommand,
      });
      startup.leaseId = undefined;
      writeRecorderStartup(startupPath, startup);
    } catch (error) {
      errors.push(`stop Crabbox: ${coerceErrorMessage(error)}`);
    }
  }
  if (errors.length) {
    throw new Error(`Recorder startup recovery completed with errors:\n${errors.join("\n")}`);
  }
  fs.rmSync(startupPath);
  return { recovered: true };
}

export function recorderArtifacts(
  cwd: string,
  opts: ArtifactsOptions,
): { artifacts: Record<string, string> } {
  const sessionPath = resolveRecorderPath(cwd, opts.sessionPath, "--session");
  const outputDir = path.dirname(sessionPath);
  const session = readRecorderSession(sessionPath);
  const artifacts: Record<string, string> = {};
  for (const [name, file] of Object.entries(session.artifacts ?? {})) {
    const resolved = path.resolve(file);
    const relative = path.relative(outputDir, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Recorder artifact ${name} is outside its session directory.`);
    }
    const metadata = fs.lstatSync(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Recorder artifact ${name} is not a regular file.`);
    }
    fs.chmodSync(resolved, metadata.mode | 0o040);
    artifacts[name] = resolved;
  }
  return { artifacts };
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
  const sessionPath = resolveRecorderPath(cwd, opts.sessionPath, "--session");
  const session = readRecorderSession(sessionPath);
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
  crop: ReturnType<typeof proofViewport>;
  cwd: string;
  inspect: CrabboxInspect;
  localPath: string;
  operations: RecorderOperations;
  remotePath: string;
}): Promise<void> {
  await params.operations.sshRun({
    command: `set -euo pipefail\nDISPLAY=:99 scrot -o -a ${params.crop.x},${params.crop.y},${params.crop.width},${params.crop.height} ${shellQuote(params.remotePath)}`,
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
  const sessionPath = resolveRecorderPath(cwd, opts.sessionPath, "--session");
  const session = readRecorderSession(sessionPath);
  const output =
    opts.output ??
    path.join(
      path.dirname(opts.sessionPath),
      `telegram-desktop-recorder-screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`,
    );
  const outputPath = resolveRecorderPath(cwd, output, "--output");
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const inspect = await sessionInspect({ crabboxBin, cwd, operations, session });
  await captureScreenshot({
    crop: proofViewport(session.window),
    cwd,
    inspect,
    localPath: outputPath,
    operations,
    remotePath: `${REMOTE_ROOT}/screenshot.png`,
  });
  return outputPath;
}

export async function stopRecorder(
  cwd: string,
  opts: StopOptions,
  operations: RecorderOperations = defaultOperations,
): Promise<RecorderSession> {
  const sessionPath = resolveRecorderPath(cwd, opts.sessionPath, "--session");
  const session = readRecorderSession(sessionPath);
  const crabboxBin = process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox";
  const outputDir = path.dirname(sessionPath);
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
  let leaseGone = false;
  await attempt("inspect", async () => {
    try {
      inspect = await sessionInspect({ crabboxBin, cwd, operations, session });
    } catch (error) {
      // A lease that no longer exists is the desired end state, not a failure.
      if (coerceErrorMessage(error).includes("lease not found")) {
        leaseGone = true;
        return;
      }
      throw error;
    }
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
        crop: proofViewport(session.window),
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
  // A missing lease produces no local video, so there is no preview to build.
  if (artifacts.video) {
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
          crabboxBin,
          crop: proofViewport(session.window),
          croppedGifPath,
          croppedVideoPath,
          cwd,
          fps: DEFAULT_PREVIEW_FPS,
          run: operations.runCommand,
          videoPath,
        });
        artifacts.previewGifCropped = croppedGifPath;
        artifacts.trimmedVideoCropped = croppedVideoPath;
      });
    } else {
      await attempt("motion preview", async () => {
        await operations.createMotionPreview({
          crabboxBin,
          cwd,
          fps: DEFAULT_PREVIEW_FPS,
          gifPath: motionGifPath,
          run: operations.runCommand,
          trimmedVideoPath: motionVideoPath,
          videoPath,
          width: 1920,
        });
        artifacts.previewGif = motionGifPath;
        artifacts.trimmedVideo = motionVideoPath;
      });
    }
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
  if (!opts.keepBox && session.leaseOwned && !leaseGone) {
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
    // Keep paths recorded by an earlier stop (--keep-box, then a later stop once
    // the lease expired); fresh copies overwrite their own entries.
    artifacts: { ...session.artifacts, ...artifacts },
    cleanupErrors: errors.length ? errors : undefined,
    keepBox: opts.keepBox,
    stoppedAt: new Date().toISOString(),
  };
  writeRecorderSession(sessionPath, stopped);
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
  const sessionPath = resolveRecorderPath(cwd, opts.sessionPath, "--session");
  const session = readRecorderSession(sessionPath);
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
  if (opts.command === "artifacts") {
    console.log(JSON.stringify(recorderArtifacts(cwd, opts), null, 2));
    return;
  }
  if (opts.command === "recover") {
    console.log(JSON.stringify(await recoverRecorderStartup(cwd, opts), null, 2));
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
