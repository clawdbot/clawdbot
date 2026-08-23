import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import { coerceErrorMessage, toStringifiedError } from "../lib/error-format.mts";
import { signalExitCode, terminateManagedChild } from "../lib/managed-child-process.mts";

const crabboxInspectSchema = z.object({
  host: z.string().optional(),
  id: z.string().optional(),
  slug: z.string().optional(),
  sshFallbackPorts: z.array(z.string()).optional(),
  sshHost: z.string().optional(),
  sshKey: z.string().optional(),
  sshPort: z.string().optional(),
  sshUser: z.string().optional(),
  state: z.string().optional(),
  tailscale: z.unknown().optional(),
});

export type CrabboxInspect = z.infer<typeof crabboxInspectSchema>;

export type CommandResult = {
  stderr: string;
  stdout: string;
};

export type RunCommand = (params: RunCommandParams) => Promise<CommandResult>;

type RunCommandParams = {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  outputFile?: string;
  redactValues?: string[];
  shell?: boolean | string;
  stdio?: "inherit" | "pipe";
  stdin?: string;
  timeoutKillGraceMs?: number;
  timeoutMs?: number;
  windowsVerbatimArguments?: boolean;
};

type TelegramRecordingPaths = {
  ffmpegLog: string;
  ffmpegPid: string;
  video: string;
};

export type TelegramCrop = {
  cropWidth: number;
  height: number;
  width: number;
  x: number;
  y: number;
};

export const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const COMMAND_TIMEOUT_KILL_GRACE_MS = 5_000;
const COMMAND_PROCESS_TREE_EXIT_POLL_MS = 25;
const COMMAND_STDOUT_MAX_CHARS = 1024 * 1024;
const COMMAND_STDERR_TAIL_CHARS = 256 * 1024;
const COMMAND_FAILURE_STDOUT_TAIL_CHARS = 64 * 1024;

export const TELEGRAM_DESKTOP_WINDOW = {
  height: 1000,
  width: 650,
  x: 635,
  y: 40,
} as const;

export const TELEGRAM_DESKTOP_CROP = {
  cropWidth: 430,
  height: TELEGRAM_DESKTOP_WINDOW.height,
  width: 430,
  x: TELEGRAM_DESKTOP_WINDOW.x + 220,
  y: TELEGRAM_DESKTOP_WINDOW.y,
} as const;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function redactCommandText(value: string, redactions: string[] | undefined): string {
  let redacted = value;
  for (const secret of redactions ?? []) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted;
}

function resolvedTimerMs(value: number): number {
  return clampTimerTimeoutMs(value) ?? 1;
}

function appendTextTail(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length > maxChars ? sliceUtf16Safe(next, -maxChars) : next;
}

function commandFailureOutput(stdout: string, stderr: string): string {
  const stdoutTail =
    stdout.length > COMMAND_FAILURE_STDOUT_TAIL_CHARS
      ? `\n[stdout truncated to last ${COMMAND_FAILURE_STDOUT_TAIL_CHARS} characters]\n${sliceUtf16Safe(stdout, -COMMAND_FAILURE_STDOUT_TAIL_CHARS)}`
      : stdout;
  return `${stdoutTail}${stderr}`;
}

function timedOutError(message: string): Error & { code: "ETIMEDOUT" } {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" as const });
}

const activeCommandChildren = new Set<ChildProcess>();
let commandCleanupHandlersInstalled = false;

function commandProcessTreeAlive(child: ChildProcess): boolean {
  if (!child.pid || process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitForCommandProcessTreeExit(child: ChildProcess, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!commandProcessTreeAlive(child)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, COMMAND_PROCESS_TREE_EXIT_POLL_MS);
    });
  }
}

async function finishTimedOutCommandProcessTree(
  child: ChildProcess,
  options: { forceKillAt: number | undefined; timeoutKillGraceMs: number },
): Promise<void> {
  if (!commandProcessTreeAlive(child)) {
    activeCommandChildren.delete(child);
    return;
  }
  const graceRemainingMs =
    options.forceKillAt === undefined
      ? options.timeoutKillGraceMs
      : Math.max(0, options.forceKillAt - Date.now());
  if (graceRemainingMs > 0) {
    await waitForCommandProcessTreeExit(child, graceRemainingMs);
  }
  if (commandProcessTreeAlive(child)) {
    terminateManagedChild(child, "SIGKILL");
    await waitForCommandProcessTreeExit(child, options.timeoutKillGraceMs);
  }
  activeCommandChildren.delete(child);
}

function untrackCommandChild(child: ChildProcess): void {
  if (!commandProcessTreeAlive(child)) {
    activeCommandChildren.delete(child);
  }
}

function signalActiveCommandChildren(signal: NodeJS.Signals): void {
  for (const child of activeCommandChildren) {
    terminateManagedChild(child, signal);
  }
}

function installCommandCleanupHandlers(): void {
  if (commandCleanupHandlersInstalled) {
    return;
  }
  commandCleanupHandlersInstalled = true;
  process.once("exit", () => {
    signalActiveCommandChildren("SIGTERM");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      signalActiveCommandChildren(signal);
      process.kill(process.pid, signal);
    });
  }
}

export function runCommand(params: RunCommandParams): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (params.outputFile) {
      fs.writeFileSync(params.outputFile, "");
    }
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      detached: process.platform !== "win32",
      env: params.env ?? process.env,
      shell: params.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: params.windowsVerbatimArguments,
    });
    activeCommandChildren.add(child);
    installCommandCleanupHandlers();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdoutLimitError: string | undefined;
    let timeoutError: Error | undefined;
    let forceKillAt: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutMs = resolvedTimerMs(params.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const timeoutKillGraceMs = resolvedTimerMs(
      params.timeoutKillGraceMs ?? COMMAND_TIMEOUT_KILL_GRACE_MS,
    );
    const clearTimers = () => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };
    const commandLabel = redactCommandText(
      `${params.command} ${params.args.join(" ")}`,
      params.redactValues,
    );
    const failureOutput = () =>
      redactCommandText(commandFailureOutput(stdout, stderr), params.redactValues);
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      timeoutError = timedOutError(
        `${commandLabel} timed out after ${timeoutMs}ms\n${failureOutput()}`,
      );
      terminateManagedChild(child, "SIGTERM");
      forceKillAt = Date.now() + timeoutKillGraceMs;
      killTimer = setTimeout(() => {
        terminateManagedChild(child, "SIGKILL");
      }, timeoutKillGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (params.outputFile) {
        fs.appendFileSync(params.outputFile, chunk);
        stdout = appendTextTail(stdout, chunk, COMMAND_FAILURE_STDOUT_TAIL_CHARS);
      } else if (params.stdio === "inherit") {
        stdout = appendTextTail(stdout, chunk, COMMAND_FAILURE_STDOUT_TAIL_CHARS);
      } else {
        const next = stdout + chunk;
        if (next.length > COMMAND_STDOUT_MAX_CHARS) {
          stdoutLimitError = `command stdout exceeded ${COMMAND_STDOUT_MAX_CHARS} characters`;
          terminateManagedChild(child, "SIGKILL");
        } else {
          stdout = next;
        }
      }
      if (params.stdio === "inherit") {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (params.outputFile) {
        fs.appendFileSync(params.outputFile, chunk);
      }
      stderr = appendTextTail(stderr, chunk, COMMAND_STDERR_TAIL_CHARS);
      if (params.stdio === "inherit") {
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      untrackCommandChild(child);
      clearTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      untrackCommandChild(child);
      if (timeoutError) {
        const error = timeoutError;
        clearTimers();
        void finishTimedOutCommandProcessTree(child, { forceKillAt, timeoutKillGraceMs }).then(
          () => reject(error),
          (cleanupError: unknown) => reject(toStringifiedError(cleanupError)),
        );
        return;
      }
      clearTimers();
      if (stdoutLimitError) {
        reject(new Error(`${commandLabel} failed: ${stdoutLimitError}`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = signal
        ? `signal ${signal} (exit code ${signalExitCode(signal)})`
        : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${commandLabel} failed with ${detail}\n${failureOutput()}`));
    });
    child.stdin.end(params.stdin);
  });
}

export function extractCrabboxLeaseId(output: string): string | undefined {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}

export function createDesktopCrabboxWarmupArgs(params: {
  browser?: boolean;
  crabboxClass: string;
  idleTimeout: string;
  /** Baked application requirement (`name=version`); selects a catalog-only variant image. */
  imageSdk?: string;
  provider: string;
  tailscale?: boolean;
  target?: string;
  ttl: string;
}): string[] {
  return [
    "warmup",
    "--provider",
    params.provider,
    "--target",
    params.target ?? "linux",
    "--desktop",
    ...(params.browser ? ["--browser"] : []),
    ...(params.imageSdk ? ["--image-sdk", params.imageSdk] : []),
    "--class",
    params.crabboxClass,
    "--idle-timeout",
    params.idleTimeout,
    "--ttl",
    params.ttl,
    ...(params.tailscale ? ["--tailscale"] : []),
  ];
}

export async function inspectCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  leaseId: string;
  provider: string;
  run?: RunCommand;
  target?: string;
}): Promise<CrabboxInspect> {
  const result = await (params.run ?? runCommand)({
    args: [
      "inspect",
      "--provider",
      params.provider,
      "--target",
      params.target ?? "linux",
      "--id",
      params.leaseId,
      "--json",
    ],
    command: params.crabboxBin,
    cwd: params.cwd,
  });
  return crabboxInspectSchema.parse(JSON.parse(result.stdout));
}

function crabboxSshPortCandidates(
  inspect: Pick<CrabboxInspect, "sshFallbackPorts" | "sshPort">,
): string[] {
  const ports = [inspect.sshPort?.trim() || "22", ...(inspect.sshFallbackPorts ?? [])];
  return [...new Set(ports.map((port) => port.trim()).filter(Boolean))];
}

export function crabboxSshArgs(
  inspect: CrabboxInspect,
  sshPort = inspect.sshPort?.trim() || "22",
): { base: string[]; scpBase: string[]; sshPort: string; target: string } {
  const sshHost = inspect.sshHost || inspect.host;
  if (!sshHost || !inspect.sshKey || !inspect.sshUser) {
    throw new Error("Crabbox inspect output is missing SSH details.");
  }
  const common = [
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
  ];
  return {
    base: ["-i", inspect.sshKey, "-p", sshPort, ...common],
    scpBase: ["-i", inspect.sshKey, "-P", sshPort, ...common],
    sshPort,
    target: `${inspect.sshUser}@${sshHost}`,
  };
}

function isTransientSshFailure(error: unknown): boolean {
  return /Connection (?:closed|reset)|Operation timed out|Connection timed out/u.test(
    coerceErrorMessage(error),
  );
}

function isSshConnectionFailure(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return (
    code === "ETIMEDOUT" ||
    isTransientSshFailure(error) ||
    /Connection refused|Network is unreachable|No route to host/u.test(coerceErrorMessage(error))
  );
}

export async function selectCrabboxSshPort(params: {
  inspect: Pick<CrabboxInspect, "sshFallbackPorts" | "sshPort">;
  probe: (port: string) => Promise<void>;
}): Promise<string> {
  let lastError: unknown;
  for (const port of crabboxSshPortCandidates(params.inspect)) {
    try {
      await params.probe(port);
      return port;
    } catch (error) {
      if (!isSshConnectionFailure(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

async function runRemoteCommand(params: RunCommandParams, run: RunCommand): Promise<CommandResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await run(params);
    } catch (error) {
      lastError = error;
      if (attempt === 4 || !isTransientSshFailure(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt * 3000);
      });
    }
  }
  throw lastError;
}

const selectedSshPorts = new WeakMap<CrabboxInspect, string>();

export async function selectedCrabboxSshArgs(
  cwd: string,
  inspect: CrabboxInspect,
  run: RunCommand,
): Promise<ReturnType<typeof crabboxSshArgs>> {
  let sshPort = selectedSshPorts.get(inspect);
  if (!sshPort) {
    // Probe once so a fallback never replays a state-changing command or transfer.
    sshPort = await selectCrabboxSshPort({
      inspect,
      probe: async (port) => {
        const ssh = crabboxSshArgs(inspect, port);
        await run({ args: [...ssh.base, ssh.target, "exit 0"], command: "ssh", cwd });
      },
    });
    selectedSshPorts.set(inspect, sshPort);
  }
  return crabboxSshArgs(inspect, sshPort);
}

export async function scpFromRemote(params: {
  cwd: string;
  inspect: CrabboxInspect;
  local: string;
  remote: string;
  run?: RunCommand;
}): Promise<void> {
  const run = params.run ?? runCommand;
  const ssh = await selectedCrabboxSshArgs(params.cwd, params.inspect, run);
  await runRemoteCommand(
    {
      args: [...ssh.scpBase, `${ssh.target}:${params.remote}`, params.local],
      command: "scp",
      cwd: params.cwd,
      stdio: "inherit",
    },
    run,
  );
}

export async function scpToRemote(params: {
  cwd: string;
  inspect: CrabboxInspect;
  local: string;
  remote: string;
  run?: RunCommand;
}): Promise<void> {
  const run = params.run ?? runCommand;
  const ssh = await selectedCrabboxSshArgs(params.cwd, params.inspect, run);
  await runRemoteCommand(
    {
      args: [...ssh.scpBase, params.local, `${ssh.target}:${params.remote}`],
      command: "scp",
      cwd: params.cwd,
      stdio: "inherit",
    },
    run,
  );
}

export async function sshRun(params: {
  command: string;
  cwd: string;
  inspect: CrabboxInspect;
  outputFile?: string;
  run?: RunCommand;
  stdio?: "inherit" | "pipe";
  timeoutMs?: number;
}): Promise<CommandResult> {
  const run = params.run ?? runCommand;
  const ssh = await selectedCrabboxSshArgs(params.cwd, params.inspect, run);
  return await runRemoteCommand(
    {
      args: [...ssh.base, ssh.target, params.command],
      command: "ssh",
      cwd: params.cwd,
      outputFile: params.outputFile,
      stdio: params.stdio ?? "inherit",
      timeoutMs: params.timeoutMs,
    },
    run,
  );
}

export async function createMotionPreview(params: {
  crabboxBin: string;
  cwd: string;
  fps: number;
  gifPath: string;
  run?: RunCommand;
  trimmedVideoPath: string;
  videoPath: string;
  width: number;
}): Promise<Record<string, unknown>> {
  const preview = await (params.run ?? runCommand)({
    args: [
      "media",
      "preview",
      "--input",
      params.videoPath,
      "--output",
      params.gifPath,
      "--fps",
      String(params.fps),
      "--width",
      String(params.width),
      "--trimmed-video-output",
      params.trimmedVideoPath,
      "--json",
    ],
    command: params.crabboxBin,
    cwd: params.cwd,
    stdio: "inherit",
  });
  return z.record(z.string(), z.unknown()).parse(JSON.parse(preview.stdout));
}

export async function createCroppedMotionPreview(params: {
  crabboxBin: string;
  crop: TelegramCrop;
  croppedGifPath: string;
  croppedVideoPath: string;
  cwd: string;
  fps: number;
  run?: RunCommand;
  videoPath: string;
}): Promise<{ crop: string; fps: number; outputWidth: number }> {
  const run = params.run ?? runCommand;
  const crop = `crop=${params.crop.width}:${params.crop.height}:${params.crop.x}:${params.crop.y}`;
  const scale = `scale=${params.crop.cropWidth}:-2:flags=lanczos`;
  const croppedSourcePath = `${params.croppedVideoPath}.source.mp4`;
  try {
    await run({
      args: [
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        params.videoPath,
        "-vf",
        `${crop},${scale}`,
        "-pix_fmt",
        "yuv420p",
        croppedSourcePath,
      ],
      command: "ffmpeg",
      cwd: params.cwd,
      stdio: "inherit",
    });
    await createMotionPreview({
      crabboxBin: params.crabboxBin,
      cwd: params.cwd,
      fps: params.fps,
      gifPath: params.croppedGifPath,
      run,
      trimmedVideoPath: params.croppedVideoPath,
      videoPath: croppedSourcePath,
      width: params.crop.cropWidth,
    });
  } finally {
    fs.rmSync(croppedSourcePath, { force: true });
  }
  return { crop, fps: params.fps, outputWidth: params.crop.cropWidth };
}

export function renderStartRemoteRecording(params: {
  paths: TelegramRecordingPaths;
  recordFps: number;
}): string {
  return `set -euo pipefail
export DISPLAY="\${DISPLAY:-:99}"
video=${shellQuote(params.paths.video)}
log=${shellQuote(params.paths.ffmpegLog)}
pid_file=${shellQuote(params.paths.ffmpegPid)}
rm -f "$video" "$log" "$pid_file"
size="$(xdpyinfo | awk '/dimensions:/ {size=$2} END {if (!size) exit 1; print size}')"
nohup ffmpeg -y -hide_banner -loglevel warning -f x11grab -framerate ${params.recordFps} -video_size "$size" -i "$DISPLAY" -pix_fmt yuv420p "$video" >"$log" 2>&1 &
echo $! >"$pid_file"`;
}

export function renderStopRemoteRecording(pidFile: string): string {
  return `set -euo pipefail
pid_file=${shellQuote(pidFile)}
if [ -s "$pid_file" ]; then
  pid="$(cat "$pid_file")"
  kill -INT "$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" >/dev/null 2>&1 || exit 0
    sleep 0.5
  done
  kill -TERM "$pid" >/dev/null 2>&1 || true
fi`;
}

export async function startRemoteRecording(params: {
  cwd: string;
  inspect: CrabboxInspect;
  paths: TelegramRecordingPaths;
  recordFps: number;
  run?: RunCommand;
}): Promise<TelegramRecordingPaths> {
  await sshRun({
    command: renderStartRemoteRecording(params),
    cwd: params.cwd,
    inspect: params.inspect,
    run: params.run,
  });
  return params.paths;
}

export async function stopRemoteRecording(params: {
  cwd: string;
  inspect: CrabboxInspect;
  pidFile: string;
  run?: RunCommand;
}): Promise<void> {
  await sshRun({
    command: renderStopRemoteRecording(params.pidFile),
    cwd: params.cwd,
    inspect: params.inspect,
    run: params.run,
  });
}

export function telegramPrivatePostLink(groupId: string, messageId?: string): string {
  if (!/^-100\d+$/u.test(groupId)) {
    throw new Error(`Telegram privatepost links require a -100 group id, got ${groupId}.`);
  }
  // tdesktop's ResolvePrivatePost only requires channel; an absent post opens the chat
  // itself, which is all the recorder needs to keep the account's chat list off screen.
  const chatLink = `tg://privatepost?channel=${groupId.slice(4)}`;
  return messageId ? `${chatLink}&post=${messageId}` : chatLink;
}

export function renderTelegramViewCommand(params: {
  binary: string;
  link?: string;
  workdir: string;
}): string {
  const openLink = params.link
    ? `set +e
timeout 5 ${shellQuote(params.binary)} -workdir ${shellQuote(params.workdir)} ${shellQuote(params.link)}
status="$?"
set -e
if [ "$status" -ne 0 ] && [ "$status" -ne 124 ]; then
  exit "$status"
fi
sleep 1`
    : "";
  return `set -euo pipefail
export DISPLAY="\${DISPLAY:-:99}"
win="$(wmctrl -lxG | awk 'tolower($0) ~ /telegramdesktop/ {print $1; exit}')"
if [ -z "$win" ]; then
  echo "Telegram Desktop window not found." >&2
  exit 1
fi
wmctrl -ir "$win" -b remove,maximized_vert,maximized_horz,fullscreen
wmctrl -ir "$win" -e 0,${TELEGRAM_DESKTOP_WINDOW.x},${TELEGRAM_DESKTOP_WINDOW.y},${TELEGRAM_DESKTOP_WINDOW.width},${TELEGRAM_DESKTOP_WINDOW.height}
${openLink}
xdotool windowmap "$win"
xdotool windowactivate --sync "$win"
wmctrl -lxG | awk 'tolower($0) ~ /telegramdesktop/'`;
}
