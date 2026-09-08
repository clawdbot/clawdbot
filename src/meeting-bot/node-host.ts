import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import type { MeetingAudioBackendSelection, MeetingAudioRuntime } from "./audio-backend.js";
import { decodeMeetingAudioBase64 } from "./audio-base64.js";
import { terminateMeetingBridgeProcess } from "./bridge-process.js";
import { splitCommandArgv } from "./command-argv.js";
import {
  prepareMeetingNodeAudio,
  readMeetingNodeCommand,
  type MeetingNodeAudioConfig,
} from "./node-audio-config.js";
import { MeetingNodeAudioPullWaiters } from "./node-audio-pull-waiters.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

export type { MeetingNodeAudioConfig } from "./node-audio-config.js";

const NODE_BRIDGE_TERMINATION_GRACE_MS = 2_000;
const NODE_BRIDGE_INPUT_DRAIN_MS = NODE_BRIDGE_TERMINATION_GRACE_MS + 1_000;
const NODE_BRIDGE_TERMINAL_RETENTION_MS = 5_000;
const NODE_BRIDGE_MAX_QUEUED_INPUT_CHUNKS = 200;
const NODE_BRIDGE_MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

type NodeOutputWriteWaiter = {
  output: ChildProcess;
  release: () => void;
};

type NodeBridgeSession = {
  id: string;
  url?: string;
  mode?: string;
  outputCommand: { command: string; args: string[] };
  input?: ChildProcess;
  output?: ChildProcess;
  chunks: Buffer[];
  queuedInputBytes: number;
  waiters: MeetingNodeAudioPullWaiters;
  closed: boolean;
  createdAt: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastClearAt?: string;
  lastInputBytes: number;
  lastOutputBytes: number;
  clearCount: number;
  outputGeneration: number;
  outputWriteWaiters: Set<NodeOutputWriteWaiter>;
  stopPromise?: Promise<void>;
  retiredOutputStops: Set<Promise<void>>;
  stopping: boolean;
  discardQueuedAudioOnStop: boolean;
  terminalEvictionTimer?: ReturnType<typeof setTimeout>;
};

export type MeetingNodeHostOptions = {
  commandName: string;
  displayName: string;
  browserLabel: string;
  bridgeIdPrefix: string;
  defaultAudioInputCommand: readonly string[];
  defaultAudioOutputCommand: readonly string[];
  defaultAudio?: {
    backend?: MeetingAudioBackendSelection;
    bufferBytes: number;
    format: MeetingRealtimeAudioFormat;
  };
  talkBackModes: ReadonlySet<string>;
  agentMode: string;
  normalizeUrl(input: unknown): string;
  normalizeMeetingKey(url?: string): string | undefined;
  assertAudioAvailable(timeoutMs: number): void | Promise<void>;
  prepareAudio?(config: MeetingNodeAudioConfig, timeoutMs: number): Promise<MeetingAudioRuntime>;
  browser: {
    application: string;
    buildProfileArgs(profile: string): string[];
    openedStatus: string;
    openedNotes: string[];
  };
};

function readPositiveNumberOr(value: unknown, fallback: number): number {
  return asPositiveFiniteNumber(value) ?? fallback;
}

function readOutputGeneration(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error("outputGeneration must be a non-negative integer");
}

function runCommandWithTimeout(argv: string[], timeoutMs: number) {
  const { command, args } = splitCommandArgv(argv, "command");
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  const errorMessage = result.error ? formatErrorMessage(result.error) : "";
  const stderr =
    errorMessage && result.stderr
      ? `${errorMessage}: ${result.stderr}`
      : errorMessage || result.stderr || (result.signal ? `terminated by ${result.signal}` : "");
  return {
    code: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr,
  };
}

function waitForInputDrain(
  stream: ChildProcess["stdout"] | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!stream || stream.readableEnded || stream.destroyed) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stream.off("end", finish);
      stream.off("close", finish);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    timeout.unref?.();
    stream.once("end", finish);
    stream.once("close", finish);
    if (stream.readableEnded || stream.destroyed) {
      finish();
    }
  });
}

export function createMeetingNodeHost(options: MeetingNodeHostOptions): {
  handleCommand(paramsJSON?: string | null): Promise<string>;
} {
  const sessions = new Map<string, NodeBridgeSession>();

  const wake = (session: NodeBridgeSession) => {
    session.waiters.wake();
  };

  const releaseOutputWriteWaiters = (session: NodeBridgeSession, output?: ChildProcess): void => {
    for (const waiter of session.outputWriteWaiters) {
      if (!output || waiter.output === output) {
        waiter.release();
      }
    }
  };

  const retireOutputProcess = (session: NodeBridgeSession, outputProcess?: ChildProcess) => {
    const stopPromise = terminateMeetingBridgeProcess(outputProcess, {
      graceMs: NODE_BRIDGE_TERMINATION_GRACE_MS,
    });
    session.retiredOutputStops.add(stopPromise);
    void stopPromise.finally(() => {
      session.retiredOutputStops.delete(stopPromise);
    });
  };

  const deleteSession = (session: NodeBridgeSession): void => {
    if (session.terminalEvictionTimer) {
      clearTimeout(session.terminalEvictionTimer);
      session.terminalEvictionTimer = undefined;
    }
    session.chunks.length = 0;
    session.queuedInputBytes = 0;
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
    }
  };

  const armTerminalEviction = (session: NodeBridgeSession): void => {
    if (session.terminalEvictionTimer) {
      clearTimeout(session.terminalEvictionTimer);
    }
    session.terminalEvictionTimer = setTimeout(() => {
      deleteSession(session);
    }, NODE_BRIDGE_TERMINAL_RETENTION_MS);
    session.terminalEvictionTimer.unref?.();
  };

  const stopSession = (
    session: NodeBridgeSession,
    stopOptions: { discardQueuedAudio?: boolean } = {},
  ): Promise<void> => {
    session.stopping = true;
    if (stopOptions.discardQueuedAudio) {
      session.discardQueuedAudioOnStop = true;
      if (session.terminalEvictionTimer) {
        clearTimeout(session.terminalEvictionTimer);
        session.terminalEvictionTimer = undefined;
      }
      session.chunks.length = 0;
      session.queuedInputBytes = 0;
      if (!session.closed) {
        session.closed = true;
      }
      wake(session);
    }
    releaseOutputWriteWaiters(session);
    // Process and stream errors can arrive together during teardown. Close once
    // so every caller shares one bounded process-termination promise.
    if (session.stopPromise) {
      return session.stopPromise;
    }
    const terminalReady = session.discardQueuedAudioOnStop
      ? Promise.resolve()
      : waitForInputDrain(session.input?.stdout, NODE_BRIDGE_INPUT_DRAIN_MS).then(() => {
          if (session.discardQueuedAudioOnStop || session.closed) {
            return;
          }
          session.closed = true;
          wake(session);
        });
    session.stopPromise = Promise.all([
      terminateMeetingBridgeProcess(session.input, {
        graceMs: NODE_BRIDGE_TERMINATION_GRACE_MS,
      }),
      terminateMeetingBridgeProcess(session.output, {
        graceMs: NODE_BRIDGE_TERMINATION_GRACE_MS,
      }),
      ...session.retiredOutputStops,
      terminalReady,
    ]).then(() => {
      if (session.discardQueuedAudioOnStop) {
        deleteSession(session);
        return;
      }
      // A terminal pull normally deletes the session first. This deadline
      // releases bounded retention when no consumer returns to drain it.
      armTerminalEviction(session);
    });
    return session.stopPromise;
  };

  const attachOutputProcessHandlers = (session: NodeBridgeSession, outputProcess: ChildProcess) => {
    const stopIfCurrent = () => {
      if (session.output === outputProcess) {
        void stopSession(session);
      }
    };
    outputProcess.on("exit", stopIfCurrent);
    outputProcess.on("error", stopIfCurrent);
    outputProcess.stdin?.on("error", stopIfCurrent);
    outputProcess.stderr?.on("error", stopIfCurrent);
  };

  const startOutputProcess = (command: { command: string; args: string[] }) =>
    spawn(command.command, command.args, { stdio: ["pipe", "ignore", "pipe"] });

  const startCommandPair = (params: {
    inputCommand: string[];
    outputCommand: string[];
    url?: string;
    mode?: string;
  }): NodeBridgeSession => {
    const input = splitCommandArgv(params.inputCommand, "audio command");
    const output = splitCommandArgv(params.outputCommand, "audio command");
    const session: NodeBridgeSession = {
      id: `${options.bridgeIdPrefix}${randomUUID()}`,
      url: params.url,
      mode: params.mode,
      outputCommand: output,
      chunks: [],
      queuedInputBytes: 0,
      waiters: new MeetingNodeAudioPullWaiters(),
      closed: false,
      createdAt: new Date().toISOString(),
      lastInputBytes: 0,
      lastOutputBytes: 0,
      clearCount: 0,
      outputGeneration: 0,
      outputWriteWaiters: new Set(),
      retiredOutputStops: new Set(),
      stopping: false,
      discardQueuedAudioOnStop: false,
    };
    const outputProcess = startOutputProcess(output);
    let inputProcess: ChildProcess;
    try {
      inputProcess = spawn(input.command, input.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      void terminateMeetingBridgeProcess(outputProcess, {
        graceMs: NODE_BRIDGE_TERMINATION_GRACE_MS,
      });
      throw error;
    }
    session.input = inputProcess;
    session.output = outputProcess;
    inputProcess.stdout?.on("data", (chunk) => {
      if (session.discardQueuedAudioOnStop || session.closed) {
        return;
      }
      const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      session.lastInputAt = new Date().toISOString();
      session.lastInputBytes += audio.byteLength;
      // Keep the existing normal 200-chunk window while bounding custom capture
      // commands whose stdout chunks are much larger than the default 4 KiB.
      const retainedAudio = Buffer.from(
        audio.subarray(Math.max(0, audio.byteLength - NODE_BRIDGE_MAX_QUEUED_INPUT_BYTES)),
      );
      session.chunks.push(retainedAudio);
      session.queuedInputBytes += retainedAudio.byteLength;
      while (
        session.chunks.length > NODE_BRIDGE_MAX_QUEUED_INPUT_CHUNKS ||
        session.queuedInputBytes > NODE_BRIDGE_MAX_QUEUED_INPUT_BYTES
      ) {
        const evicted = session.chunks.shift();
        if (evicted) {
          session.queuedInputBytes -= evicted.byteLength;
        }
      }
      if (!session.stopPromise) {
        wake(session);
      }
    });
    const stop = () => {
      void stopSession(session);
    };
    inputProcess.on("exit", stop);
    inputProcess.on("error", stop);
    inputProcess.stdout?.on("error", stop);
    inputProcess.stderr?.on("error", stop);
    attachOutputProcessHandlers(session, outputProcess);
    sessions.set(session.id, session);
    return session;
  };

  const pullAudio = async (params: Record<string, unknown>) => {
    const bridgeId = readNonEmptyString(params.bridgeId);
    if (!bridgeId) {
      throw new Error("bridgeId required");
    }
    const session = sessions.get(bridgeId);
    if (!session) {
      throw new Error(`unknown bridgeId: ${bridgeId}`);
    }
    const timeoutMs = Math.min(readPositiveNumberOr(params.timeoutMs, 250), 2_000);
    if (session.chunks.length === 0 && !session.closed) {
      await session.waiters.wait(timeoutMs);
    }
    const chunk = session.chunks.shift();
    if (chunk) {
      session.queuedInputBytes -= chunk.byteLength;
    }
    const closed = session.closed && session.chunks.length === 0;
    if (closed) {
      deleteSession(session);
    } else if (chunk && session.closed && session.terminalEvictionTimer) {
      // Terminal audio can span many node RPCs. Retain only while the consumer
      // keeps making progress, then evict after one full idle window.
      armTerminalEviction(session);
    }
    return {
      bridgeId,
      closed,
      base64: chunk ? chunk.toString("base64") : undefined,
    };
  };

  const staleOutputResult = (session: NodeBridgeSession) => ({
    bridgeId: session.id,
    ok: true,
    stale: true,
  });

  const writeOutputChunk = (
    session: NodeBridgeSession,
    output: ChildProcess,
    audio: Buffer,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const stdin = output.stdin;
      if (!stdin) {
        reject(new Error("audio output stream is closed"));
        return;
      }
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        session.outputWriteWaiters.delete(waiter);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const waiter: NodeOutputWriteWaiter = { output, release: () => finish() };
      session.outputWriteWaiters.add(waiter);
      try {
        stdin.write(audio, (error) => finish(error ?? undefined));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(formatErrorMessage(error)));
        return;
      }
      if (stdin.destroyed || stdin.writableEnded) {
        finish(new Error("audio output stream is closed"));
      }
    });

  const pushAudio = async (params: Record<string, unknown>) => {
    const bridgeId = readNonEmptyString(params.bridgeId);
    const base64 = readNonEmptyString(params.base64);
    if (!bridgeId || !base64) {
      throw new Error("bridgeId and base64 required");
    }
    const session = sessions.get(bridgeId);
    if (!session || session.stopping || session.closed) {
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    const requestedGeneration = readOutputGeneration(params.outputGeneration);
    if (requestedGeneration !== undefined && requestedGeneration !== session.outputGeneration) {
      return staleOutputResult(session);
    }
    const output = session.output;
    if (!output?.stdin) {
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    const audio = decodeMeetingAudioBase64(base64, "pushAudio");
    try {
      await writeOutputChunk(session, output, audio);
    } catch {
      if (
        session.output !== output ||
        (requestedGeneration !== undefined && requestedGeneration !== session.outputGeneration)
      ) {
        return staleOutputResult(session);
      }
      void stopSession(session);
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    if (
      session.stopping ||
      session.closed ||
      session.output !== output ||
      (requestedGeneration !== undefined && requestedGeneration !== session.outputGeneration)
    ) {
      return staleOutputResult(session);
    }
    session.lastOutputAt = new Date().toISOString();
    session.lastOutputBytes += audio.byteLength;
    return { bridgeId, ok: true };
  };

  const clearAudio = (params: Record<string, unknown>) => {
    const bridgeId = readNonEmptyString(params.bridgeId);
    if (!bridgeId) {
      throw new Error("bridgeId required");
    }
    const session = sessions.get(bridgeId);
    if (!session || session.stopping || session.closed) {
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    const requestedGeneration = readOutputGeneration(params.outputGeneration);
    if (requestedGeneration !== undefined && requestedGeneration <= session.outputGeneration) {
      return staleOutputResult(session);
    }
    if (requestedGeneration === undefined && session.outputGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error("outputGeneration exhausted");
    }
    const nextGeneration = requestedGeneration ?? session.outputGeneration + 1;
    const previousOutput = session.output;
    const outputProcess = startOutputProcess(session.outputCommand);
    session.output = outputProcess;
    session.outputGeneration = nextGeneration;
    attachOutputProcessHandlers(session, outputProcess);
    releaseOutputWriteWaiters(session, previousOutput);
    session.clearCount += 1;
    session.lastClearAt = new Date().toISOString();
    retireOutputProcess(session, previousOutput);
    return { bridgeId, ok: true, clearCount: session.clearCount };
  };

  const startBrowser = async (params: Record<string, unknown>) => {
    const url = options.normalizeUrl(params.url);
    const timeoutMs = readPositiveNumberOr(params.joinTimeoutMs, 30_000);
    const mode = readNonEmptyString(params.mode);
    let audioRuntime: MeetingAudioRuntime | undefined;
    let bridgeId: string | undefined;
    let audioBridge:
      | { type: "external-command" }
      | { type: "node-command-pair"; outputGeneration: true }
      | undefined;
    if (mode && options.talkBackModes.has(mode)) {
      audioRuntime = await prepareMeetingNodeAudio(params, Math.min(timeoutMs, 10_000), options);
      const healthCommand = readMeetingNodeCommand(params.audioBridgeHealthCommand);
      if (healthCommand) {
        const health = runCommandWithTimeout(healthCommand, timeoutMs);
        if (health.code !== 0) {
          throw new Error(
            `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
          );
        }
      }
      const bridgeCommand = readMeetingNodeCommand(params.audioBridgeCommand);
      if (bridgeCommand) {
        if (mode === options.agentMode) {
          throw new Error(
            "Chrome agent mode requires audioInputCommand and audioOutputCommand so OpenClaw can run STT and regular TTS directly.",
          );
        }
        const bridge = runCommandWithTimeout(bridgeCommand, timeoutMs);
        if (bridge.code !== 0) {
          throw new Error(
            `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
          );
        }
        audioBridge = { type: "external-command" };
      } else {
        const session = startCommandPair({
          inputCommand: audioRuntime.inputCommand,
          outputCommand: audioRuntime.outputCommand,
          url,
          mode,
        });
        bridgeId = session.id;
        audioBridge = { type: "node-command-pair", outputGeneration: true };
      }
    }

    if (params.launch !== false) {
      const argv = ["open", "-a", options.browser.application, url];
      const browserProfile = readNonEmptyString(params.browserProfile);
      if (browserProfile) {
        argv.push(...options.browser.buildProfileArgs(browserProfile));
      }
      try {
        const result = runCommandWithTimeout(argv, timeoutMs);
        if (result.code !== 0) {
          throw new Error(
            `failed to launch Chrome for ${options.browserLabel}: ${result.stderr || result.stdout || result.code}`,
          );
        }
      } catch (error) {
        if (bridgeId) {
          const session = sessions.get(bridgeId);
          if (session) {
            void stopSession(session, { discardQueuedAudio: true });
          }
        }
        throw error;
      }
    }
    return {
      launched: params.launch !== false,
      audioBackend: audioRuntime?.backend,
      audioDeviceLabel: audioRuntime?.deviceLabel,
      bridgeId,
      audioBridge,
      browser:
        params.launch !== false
          ? {
              status: options.browser.openedStatus,
              browserUrl: url,
              notes: options.browser.openedNotes,
            }
          : undefined,
    };
  };

  const bridgeStatus = (params: Record<string, unknown>) => {
    const bridgeId = readNonEmptyString(params.bridgeId);
    const session = bridgeId ? sessions.get(bridgeId) : undefined;
    return {
      bridge: session
        ? {
            bridgeId,
            closed: session.stopping || session.closed,
            createdAt: session.createdAt,
            lastInputAt: session.lastInputAt,
            lastOutputAt: session.lastOutputAt,
            lastClearAt: session.lastClearAt,
            lastInputBytes: session.lastInputBytes,
            lastOutputBytes: session.lastOutputBytes,
            clearCount: session.clearCount,
            queuedInputChunks: session.chunks.length,
          }
        : bridgeId
          ? { bridgeId, closed: true }
          : undefined,
    };
  };

  const summarizeSession = (session: NodeBridgeSession) => ({
    bridgeId: session.id,
    url: session.url,
    mode: session.mode,
    closed: session.closed,
    createdAt: session.createdAt,
    lastInputAt: session.lastInputAt,
    lastOutputAt: session.lastOutputAt,
    lastInputBytes: session.lastInputBytes,
    lastOutputBytes: session.lastOutputBytes,
  });

  const listSessions = (params: Record<string, unknown>) => {
    const urlKey = options.normalizeMeetingKey(readNonEmptyString(params.url));
    const mode = readNonEmptyString(params.mode);
    const bridges = [...sessions.values()]
      .filter((session) => !session.stopping && !session.closed)
      .filter((session) => !urlKey || options.normalizeMeetingKey(session.url) === urlKey)
      .filter((session) => !mode || session.mode === mode)
      .map(summarizeSession);
    return { bridges };
  };

  const stopSessionsByUrl = async (params: Record<string, unknown>) => {
    const urlKey = options.normalizeMeetingKey(readNonEmptyString(params.url));
    if (!urlKey) {
      throw new Error("url required");
    }
    const mode = readNonEmptyString(params.mode);
    const exceptBridgeId = readNonEmptyString(params.exceptBridgeId);
    let stopped = 0;
    const stopping: Promise<void>[] = [];
    for (const [bridgeId, session] of sessions) {
      if (exceptBridgeId && bridgeId === exceptBridgeId) {
        continue;
      }
      if (options.normalizeMeetingKey(session.url) !== urlKey) {
        continue;
      }
      if (mode && session.mode !== mode) {
        continue;
      }
      const wasClosed = session.stopping || session.closed;
      stopping.push(stopSession(session, { discardQueuedAudio: true }));
      if (!wasClosed) {
        stopped += 1;
      }
    }
    await Promise.all(stopping);
    return { ok: true, stopped };
  };

  const stopBrowser = async (params: Record<string, unknown>) => {
    const bridgeId = readNonEmptyString(params.bridgeId);
    if (!bridgeId) {
      return { ok: true, stopped: false };
    }
    const session = sessions.get(bridgeId);
    if (!session) {
      return { ok: true, stopped: false };
    }
    const wasStopped = session.stopping || session.closed;
    await stopSession(session, { discardQueuedAudio: true });
    return { ok: true, stopped: !wasStopped };
  };

  return {
    async handleCommand(paramsJSON?: string | null): Promise<string> {
      let raw: unknown = {};
      if (paramsJSON) {
        try {
          raw = JSON.parse(paramsJSON) as unknown;
        } catch {
          throw new Error(`${options.displayName} node host received malformed params JSON.`);
        }
      }
      const params = asOptionalRecord(raw) ?? {};
      const action = readNonEmptyString(params.action);
      let result: unknown;
      switch (action) {
        case "setup":
          {
            const audioRuntime = await prepareMeetingNodeAudio(params, 10_000, options);
            result = {
              ok: true,
              audioBackend: audioRuntime.backend,
              audioDeviceLabel: audioRuntime.deviceLabel,
            };
          }
          break;
        case "start":
          result = await startBrowser(params);
          break;
        case "status":
          result = bridgeStatus(params);
          break;
        case "list":
          result = listSessions(params);
          break;
        case "stopByUrl":
          result = await stopSessionsByUrl(params);
          break;
        case "pullAudio":
          result = await pullAudio(params);
          break;
        case "pushAudio":
          result = await pushAudio(params);
          break;
        case "clearAudio":
          result = clearAudio(params);
          break;
        case "stop":
          result = await stopBrowser(params);
          break;
        default:
          throw new Error(`unsupported ${options.commandName} action`);
      }
      return JSON.stringify(result);
    },
  };
}
