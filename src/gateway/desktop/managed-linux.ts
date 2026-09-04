import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleepWithAbort } from "@openclaw/retry";
import { tryListenOnPort } from "../../infra/ports-probe.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { runCommandBuffered } from "../../process/exec.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { ManagedRun, ProcessSupervisor, RunExit } from "../../process/supervisor/types.js";
import { getHostDesktopGuidance } from "./host-guidance.js";
import { probeRfbServer } from "./rfb-probe.js";

const MANAGED_DISPLAY_FIRST = 99;
const MANAGED_DISPLAY_LAST = 199;
const MANAGED_RESTART_LIMIT = 3;
const MANAGED_RESTART_WINDOW_MS = 5 * 60_000;
const MANAGED_READINESS_TIMEOUT_MS = 15_000;
const MANAGED_READINESS_POLL_MS = 100;
const STDERR_TAIL_CHARS = 4_096;

type ManagedResources = {
  tempDir: string;
  passwordFile: string;
  password: string;
  display: number;
  port: number;
};

type ManagedPair = {
  vnc: ManagedRun;
  session: ManagedRun;
  vncExit: ReturnType<ManagedRun["wait"]>;
  sessionExit: ReturnType<ManagedRun["wait"]>;
};

export type ManagedLinuxDesktopStatus =
  | { state: "not-started" }
  | { state: "starting"; display?: number; port?: number }
  | { state: "running"; display: number; port: number }
  | { state: "failed"; error: string; display?: number; port?: number };

export type ManagedLinuxDesktop = {
  acquire(): Promise<{
    attachment: { kind: "tcp"; host: "127.0.0.1"; port: number };
    auth: "vnc-password";
    vncPassword: string;
  }>;
  stop(): Promise<void>;
  status(): ManagedLinuxDesktopStatus;
};

function buildTigerVncArgv(resources: ManagedResources): string[] {
  return [
    "Xtigervnc",
    `:${resources.display}`,
    "-geometry",
    "1920x1080",
    "-depth",
    "24",
    "-localhost",
    "yes",
    "-rfbport",
    String(resources.port),
    "-SecurityTypes",
    "VncAuth",
    "-PasswordFile",
    resources.passwordFile,
    "-AlwaysShared",
    "-AcceptSetDesktopSize",
    "-nolisten",
    "tcp",
    "-ac",
  ];
}

function buildDesktopSessionArgv(): string[] {
  return ["startxfce4"];
}

function chooseDisplayNumber(socketNames: readonly string[]): number {
  const occupied = new Set(
    socketNames.flatMap((name) => {
      const match = /^X(\d+)$/u.exec(name);
      return match ? [Number.parseInt(match[1] ?? "", 10)] : [];
    }),
  );
  for (let display = MANAGED_DISPLAY_FIRST; display <= MANAGED_DISPLAY_LAST; display += 1) {
    if (!occupied.has(display)) {
      return display;
    }
  }
  throw new Error(
    `managed Linux desktop could not find an unused X display between :${MANAGED_DISPLAY_FIRST} and :${MANAGED_DISPLAY_LAST}`,
  );
}

function createVncPassword(random: Buffer): string {
  return random.toString("base64url").slice(0, 8);
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= STDERR_TAIL_CHARS ? next : next.slice(-STDERR_TAIL_CHARS);
}

function lastStderrLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) {
      return line;
    }
  }
  return undefined;
}

async function readDisplaySocketNames(socketDir: string): Promise<string[]> {
  try {
    return await fs.readdir(socketDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function binaryError(binary: "Xtigervnc" | "tigervncpasswd" | "startxfce4", error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `managed Linux desktop could not start ${binary}: ${reason}. ${getHostDesktopGuidance("linux")}`,
    { cause: error },
  );
}

export function createManagedLinuxDesktop(
  params: {
    supervisor?: ProcessSupervisor;
    onFailed?: (error: string) => void;
    runtime?: {
      nowMs?: () => number;
      probeRfb?: typeof probeRfbServer;
      randomBytes?: typeof crypto.randomBytes;
      readinessPollMs?: number;
      readinessTimeoutMs?: number;
      runPasswordTool?: typeof runCommandBuffered;
      sleep?: (ms: number) => Promise<void>;
      tempRoot?: string;
      tryListenOnPort?: (params: {
        port: 0;
        host: "127.0.0.1";
        exclusive: true;
      }) => Promise<number>;
      x11SocketDir?: string;
    };
  } = {},
): ManagedLinuxDesktop {
  const supervisor = params.supervisor ?? getProcessSupervisor();
  const nowMs = params.runtime?.nowMs ?? Date.now;
  const probeRfb = params.runtime?.probeRfb ?? probeRfbServer;
  const randomBytes = params.runtime?.randomBytes ?? crypto.randomBytes;
  const readinessPollMs = params.runtime?.readinessPollMs ?? MANAGED_READINESS_POLL_MS;
  const readinessTimeoutMs = params.runtime?.readinessTimeoutMs ?? MANAGED_READINESS_TIMEOUT_MS;
  const runPasswordTool = params.runtime?.runPasswordTool ?? runCommandBuffered;
  // ref:false keeps readiness polling from pinning an otherwise idle process alive.
  const wait =
    params.runtime?.sleep ?? ((ms: number) => sleepWithAbort(ms, undefined, { ref: false }));
  const tempRoot = params.runtime?.tempRoot ?? os.tmpdir();
  const pickPort = params.runtime?.tryListenOnPort ?? tryListenOnPort;
  const x11SocketDir = params.runtime?.x11SocketDir ?? "/tmp/.X11-unix";
  const scopeKey = `host-desktop-managed-linux:${crypto.randomUUID()}`;

  let status: ManagedLinuxDesktopStatus = { state: "not-started" };
  let resources: ManagedResources | undefined;
  let pair: ManagedPair | undefined;
  let startPromise: Promise<ManagedResources> | undefined;
  let epoch = 0;
  let stopping = false;
  let stderrTail = "";
  let restartTimes: number[] = [];
  const activeWaits = new Set<Promise<RunExit>>();

  const publicResult = (active: ManagedResources) => ({
    attachment: {
      kind: "tcp" as const,
      host: "127.0.0.1" as const,
      port: active.port,
    },
    auth: "vnc-password" as const,
    vncPassword: active.password,
  });

  const removeResources = async () => {
    const current = resources;
    resources = undefined;
    if (current) {
      await fs.rm(current.tempDir, { recursive: true, force: true });
    }
  };

  const markFailed = (error: Error) => {
    const coordinates = resources
      ? { display: resources.display, port: resources.port }
      : status.state === "starting" || status.state === "failed"
        ? { display: status.display, port: status.port }
        : {};
    status = { state: "failed", error: error.message, ...coordinates };
    params.onFailed?.(error.message);
  };

  const prepareResources = async (): Promise<ManagedResources> => {
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-desktop-"));
    await fs.chmod(tempDir, 0o700);
    const plaintextFile = path.join(tempDir, "password.txt");
    const passwordFile = path.join(tempDir, "passwd");
    try {
      const password = createVncPassword(randomBytes(12));
      registerSecretValueForRedaction(password);
      await fs.writeFile(plaintextFile, password, { mode: 0o600, flag: "wx" });
      const passwordInput = await fs.readFile(plaintextFile);
      const filtered = await runPasswordTool(["tigervncpasswd", "-f"], {
        input: passwordInput,
        maxOutputBytes: { stdout: 64, stderr: 4_096 },
        timeoutMs: 10_000,
      });
      if (filtered.termination !== "exit" || filtered.code !== 0 || filtered.stdout.length === 0) {
        const detail = filtered.error?.message ?? filtered.stderr.toString("utf8").trim();
        throw binaryError("tigervncpasswd", detail || `exit code ${filtered.code ?? "none"}`);
      }
      await fs.writeFile(passwordFile, filtered.stdout, { mode: 0o600, flag: "wx" });
      await fs.rm(plaintextFile, { force: true });
      const port = await pickPort({ port: 0, host: "127.0.0.1", exclusive: true });
      const display = chooseDisplayNumber(await readDisplaySocketNames(x11SocketDir));
      return { tempDir, passwordFile, password, display, port };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  };

  const waitUntilReady = async (active: ManagedResources, activeEpoch: number) => {
    const deadline = nowMs() + readinessTimeoutMs;
    let lastProbe = "unreachable";
    for (;;) {
      if (activeEpoch !== epoch || stopping) {
        break;
      }
      const probe = await probeRfb({
        host: "127.0.0.1",
        port: active.port,
        timeoutMs: Math.min(1_000, readinessTimeoutMs),
      });
      lastProbe = probe.kind;
      if (probe.kind === "rfb" && probe.securityTypes.includes(2)) {
        return;
      }
      if (nowMs() >= deadline) {
        break;
      }
      await wait(readinessPollMs);
    }
    if (activeEpoch !== epoch || stopping) {
      throw new Error("managed Linux desktop stopped during startup");
    }
    throw new Error(
      `managed Linux desktop did not become ready on 127.0.0.1:${active.port} within ${readinessTimeoutMs}ms (last probe: ${lastProbe})`,
    );
  };

  const stopPair = async (current: ManagedPair | undefined) => {
    supervisor.cancelScope(scopeKey, "manual-cancel");
    await Promise.allSettled(activeWaits);
    if (pair === current) {
      pair = undefined;
    }
  };

  const waitForRun = (run: ManagedRun): Promise<RunExit> => {
    const pending = run.wait().catch((error: unknown): RunExit => ({
      reason: "spawn-error",
      exitCode: null,
      exitSignal: null,
      durationMs: Math.max(0, nowMs() - run.startedAtMs),
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      noOutputTimedOut: false,
    }));
    activeWaits.add(pending);
    void pending.finally(() => activeWaits.delete(pending));
    return pending;
  };

  const spawnRun = async (
    binary: "Xtigervnc" | "startxfce4",
    argv: string[],
    env?: NodeJS.ProcessEnv,
  ) => {
    try {
      return await supervisor.spawn({
        sessionId: "host-desktop-managed-linux",
        backendId: binary === "Xtigervnc" ? "managed-vnc" : "managed-session",
        scopeKey,
        mode: "child",
        argv,
        ...(env ? { env } : {}),
        stdinMode: "pipe-closed",
        maxCapturedOutputChars: STDERR_TAIL_CHARS,
        onStderr: (chunk) => {
          stderrTail = appendTail(stderrTail, chunk);
        },
      });
    } catch (error) {
      throw binaryError(binary, error);
    }
  };

  const describeExit = (binary: string, exit: Awaited<ReturnType<ManagedRun["wait"]>>) => {
    const stderr = lastStderrLine(exit.stderr) ?? lastStderrLine(stderrTail);
    return stderr ?? `${binary} exited with code ${exit.exitCode ?? "none"}`;
  };

  const startPair = async (active: ManagedResources, activeEpoch: number): Promise<ManagedPair> => {
    status = { state: "starting", display: active.display, port: active.port };
    const vnc = await spawnRun("Xtigervnc", buildTigerVncArgv(active));
    const vncExit = waitForRun(vnc);
    try {
      await Promise.race([
        waitUntilReady(active, activeEpoch),
        vncExit.then((exit) => {
          throw new Error(describeExit("Xtigervnc", exit));
        }),
      ]);
      if (activeEpoch !== epoch || stopping) {
        throw new Error("managed Linux desktop stopped during startup");
      }
      const session = await spawnRun("startxfce4", buildDesktopSessionArgv(), {
        ...process.env,
        DISPLAY: `:${active.display}`,
      });
      const nextPair: ManagedPair = {
        vnc,
        session,
        vncExit,
        sessionExit: waitForRun(session),
      };
      pair = nextPair;
      status = { state: "running", display: active.display, port: active.port };
      return nextPair;
    } catch (error) {
      vnc.cancel("manual-cancel");
      await Promise.allSettled([vncExit]);
      throw error;
    }
  };

  const monitorPair = (current: ManagedPair, active: ManagedResources, activeEpoch: number) => {
    void Promise.race([
      current.vncExit.then((exit) => ({ binary: "Xtigervnc", exit })),
      current.sessionExit.then((exit) => ({ binary: "startxfce4", exit })),
    ]).then(async ({ binary, exit }) => {
      if (pair !== current || activeEpoch !== epoch || stopping) {
        return;
      }
      const failure = describeExit(binary, exit);
      await stopPair(current);
      if (activeEpoch !== epoch || stopping) {
        return;
      }
      const now = nowMs();
      restartTimes = restartTimes.filter(
        (startedAt) => now - startedAt < MANAGED_RESTART_WINDOW_MS,
      );
      if (restartTimes.length >= MANAGED_RESTART_LIMIT) {
        markFailed(
          new Error(
            `managed Linux desktop failed after ${MANAGED_RESTART_LIMIT} restarts within 5 minutes: ${failure}`,
          ),
        );
        return;
      }
      restartTimes.push(now);
      try {
        const restarted = await startPair(active, activeEpoch);
        monitorPair(restarted, active, activeEpoch);
      } catch (error) {
        if (activeEpoch === epoch && !stopping) {
          markFailed(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  };

  const start = async (activeEpoch: number): Promise<ManagedResources> => {
    try {
      resources = await prepareResources();
      if (activeEpoch !== epoch || stopping) {
        throw new Error("managed Linux desktop stopped during startup");
      }
      const started = await startPair(resources, activeEpoch);
      monitorPair(started, resources, activeEpoch);
      return resources;
    } catch (error) {
      if (activeEpoch === epoch && !stopping) {
        markFailed(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  };

  return {
    async acquire() {
      if (status.state === "failed") {
        throw new Error(status.error);
      }
      if (status.state === "running" && resources) {
        return publicResult(resources);
      }
      if (!startPromise) {
        stopping = false;
        restartTimes = [];
        stderrTail = "";
        const activeEpoch = ++epoch;
        startPromise = start(activeEpoch).finally(() => {
          startPromise = undefined;
        });
      }
      return publicResult(await startPromise);
    },
    async stop() {
      stopping = true;
      ++epoch;
      const failed = status.state === "failed" ? status : undefined;
      await stopPair(pair);
      await removeResources();
      startPromise = undefined;
      restartTimes = [];
      status = failed ?? { state: "not-started" };
      stopping = false;
    },
    status() {
      return { ...status };
    },
  };
}
