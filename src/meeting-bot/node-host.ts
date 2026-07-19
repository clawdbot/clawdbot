import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { terminateMeetingBridgeProcess } from "./bridge-process.js";
import { MeetingNodeAudioPullWaiters } from "./node-audio-pull-waiters.js";

const NODE_BRIDGE_TERMINATION_GRACE_MS = 2_000;

type NodeBridgeSession = {
  id: string;
  url?: string;
  mode?: string;
  outputCommand: { command: string; args: string[] };
  input?: ChildProcess;
  output?: ChildProcess;
  chunks: Buffer[];
  waiters: MeetingNodeAudioPullWaiters;
  closed: boolean;
  createdAt: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastClearAt?: string;
  lastInputBytes: number;
  lastOutputBytes: number;
  closedAt?: string;
  clearCount: number;
  stopPromise?: Promise<void>;
  retiredOutputStops: Set<Promise<void>>;
};

export type MeetingNodeHostOptions = {
  commandName: string;
  displayName: string;
  browserLabel: string;
  bridgeIdPrefix: string;
  defaultAudioInputCommand: readonly string[];
  defaultAudioOutputCommand: readonly string[];
  talkBackModes: ReadonlySet<string>;
  agentMode: string;
  normalizeUrl(input: unknown): string;
  normalizeMeetingKey(url?: string): string | undefined;
  assertAudioAvailable(timeoutMs: number): void;
  browser: {
    application: string;
    buildProfileArgs(profile: string): string[];
    openedStatus: string;
    openedNotes: string[];
  };
};

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return result.length > 0 ? result : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function runCommandWithTimeout(argv: string[], timeoutMs: number) {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("command must not be empty");
  }
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

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio command must not be empty");
  }
  return { command, args };
}

export function createMeetingNodeHost(options: MeetingNodeHostOptions): {
  handleCommand(paramsJSON?: string | null): Promise<string>;
} {
  const sessions = new Map<string, NodeBridgeSession>();

  const wake = (session: NodeBridgeSession) => {
    session.waiters.wake();
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

  const stopSession = (session: NodeBridgeSession): Promise<void> => {
    // Process and stream errors can arrive together during teardown. Close once
    // so every caller shares one bounded process-termination promise.
    if (session.stopPromise) {
      return session.stopPromise;
    }
    session.closed = true;
    session.closedAt = new Date().toISOString();
    wake(session);
    session.stopPromise = Promise.all([
      terminateMeetingBridgeProcess(session.input, {
        graceMs: NODE_BRIDGE_TERMINATION_GRACE_MS,
      }),
      terminateMeetingBridgeProcess(session.output, {
        graceMs: NODE_BRIDGE_TERMINATION_GRACE_MS,
      }),
      ...session.retiredOutputStops,
    ]).then(() => undefined);
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
    const input = splitCommand(params.inputCommand);
    const output = splitCommand(params.outputCommand);
    const session: NodeBridgeSession = {
      id: `${options.bridgeIdPrefix}${randomUUID()}`,
      url: params.url,
      mode: params.mode,
      outputCommand: output,
      chunks: [],
      waiters: new MeetingNodeAudioPullWaiters(),
      closed: false,
      createdAt: new Date().toISOString(),
      lastInputBytes: 0,
      lastOutputBytes: 0,
      clearCount: 0,
      retiredOutputStops: new Set(),
    };
    const outputProcess = startOutputProcess(output);
    const inputProcess = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.input = inputProcess;
    session.output = outputProcess;
    inputProcess.stdout?.on("data", (chunk) => {
      const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      session.lastInputAt = new Date().toISOString();
      session.lastInputBytes += audio.byteLength;
      session.chunks.push(audio);
      if (session.chunks.length > 200) {
        session.chunks.splice(0, session.chunks.length - 200);
      }
      wake(session);
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
    const bridgeId = readString(params.bridgeId);
    if (!bridgeId) {
      throw new Error("bridgeId required");
    }
    const session = sessions.get(bridgeId);
    if (!session) {
      throw new Error(`unknown bridgeId: ${bridgeId}`);
    }
    const timeoutMs = Math.min(readNumber(params.timeoutMs, 250), 2_000);
    if (session.chunks.length === 0 && !session.closed) {
      await session.waiters.wait(timeoutMs);
    }
    const chunk = session.chunks.shift();
    return {
      bridgeId,
      closed: session.closed,
      base64: chunk ? chunk.toString("base64") : undefined,
    };
  };

  const pushAudio = (params: Record<string, unknown>) => {
    const bridgeId = readString(params.bridgeId);
    const base64 = readString(params.base64);
    if (!bridgeId || !base64) {
      throw new Error("bridgeId and base64 required");
    }
    const session = sessions.get(bridgeId);
    if (!session || session.closed) {
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    const audio = Buffer.from(base64, "base64");
    session.lastOutputAt = new Date().toISOString();
    session.lastOutputBytes += audio.byteLength;
    try {
      session.output?.stdin?.write(audio);
    } catch {
      void stopSession(session);
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    return { bridgeId, ok: true };
  };

  const clearAudio = (params: Record<string, unknown>) => {
    const bridgeId = readString(params.bridgeId);
    if (!bridgeId) {
      throw new Error("bridgeId required");
    }
    const session = sessions.get(bridgeId);
    if (!session || session.closed) {
      throw new Error(`bridge is not open: ${bridgeId}`);
    }
    const previousOutput = session.output;
    const outputProcess = startOutputProcess(session.outputCommand);
    session.output = outputProcess;
    attachOutputProcessHandlers(session, outputProcess);
    session.clearCount += 1;
    session.lastClearAt = new Date().toISOString();
    retireOutputProcess(session, previousOutput);
    return { bridgeId, ok: true, clearCount: session.clearCount };
  };

  const startBrowser = (params: Record<string, unknown>) => {
    const url = options.normalizeUrl(params.url);
    const timeoutMs = readNumber(params.joinTimeoutMs, 30_000);
    const mode = readString(params.mode);
    let bridgeId: string | undefined;
    let audioBridge: { type: "external-command" | "node-command-pair" } | undefined;
    if (mode && options.talkBackModes.has(mode)) {
      options.assertAudioAvailable(Math.min(timeoutMs, 10_000));
      const healthCommand = readStringArray(params.audioBridgeHealthCommand);
      if (healthCommand) {
        const health = runCommandWithTimeout(healthCommand, timeoutMs);
        if (health.code !== 0) {
          throw new Error(
            `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
          );
        }
      }
      const bridgeCommand = readStringArray(params.audioBridgeCommand);
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
          inputCommand: readStringArray(params.audioInputCommand) ?? [
            ...options.defaultAudioInputCommand,
          ],
          outputCommand: readStringArray(params.audioOutputCommand) ?? [
            ...options.defaultAudioOutputCommand,
          ],
          url,
          mode,
        });
        bridgeId = session.id;
        audioBridge = { type: "node-command-pair" };
      }
    }

    if (params.launch !== false) {
      const argv = ["open", "-a", options.browser.application, url];
      const browserProfile = readString(params.browserProfile);
      if (browserProfile) {
        argv.push(...options.browser.buildProfileArgs(browserProfile));
      }
      const result = runCommandWithTimeout(argv, timeoutMs);
      if (result.code !== 0) {
        if (bridgeId) {
          const session = sessions.get(bridgeId);
          if (session) {
            void stopSession(session);
          }
        }
        throw new Error(
          `failed to launch Chrome for ${options.browserLabel}: ${result.stderr || result.stdout || result.code}`,
        );
      }
    }
    return {
      launched: params.launch !== false,
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
    const bridgeId = readString(params.bridgeId);
    const session = bridgeId ? sessions.get(bridgeId) : undefined;
    return {
      bridge: session
        ? {
            bridgeId,
            closed: session.closed,
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
    closedAt: session.closedAt,
    lastInputAt: session.lastInputAt,
    lastOutputAt: session.lastOutputAt,
    lastInputBytes: session.lastInputBytes,
    lastOutputBytes: session.lastOutputBytes,
  });

  const listSessions = (params: Record<string, unknown>) => {
    const urlKey = options.normalizeMeetingKey(readString(params.url));
    const mode = readString(params.mode);
    const bridges = [...sessions.values()]
      .filter((session) => !session.closed)
      .filter((session) => !urlKey || options.normalizeMeetingKey(session.url) === urlKey)
      .filter((session) => !mode || session.mode === mode)
      .map(summarizeSession);
    return { bridges };
  };

  const stopSessionsByUrl = async (params: Record<string, unknown>) => {
    const urlKey = options.normalizeMeetingKey(readString(params.url));
    if (!urlKey) {
      throw new Error("url required");
    }
    const mode = readString(params.mode);
    const exceptBridgeId = readString(params.exceptBridgeId);
    let stopped = 0;
    const stopping: Array<{
      bridgeId: string;
      session: NodeBridgeSession;
      stopPromise: Promise<void>;
    }> = [];
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
      const wasClosed = session.closed;
      stopping.push({ bridgeId, session, stopPromise: stopSession(session) });
      if (!wasClosed) {
        stopped += 1;
      }
    }
    await Promise.all(stopping.map(({ stopPromise }) => stopPromise));
    for (const { bridgeId, session } of stopping) {
      if (sessions.get(bridgeId) === session) {
        sessions.delete(bridgeId);
      }
    }
    return { ok: true, stopped };
  };

  const stopBrowser = async (params: Record<string, unknown>) => {
    const bridgeId = readString(params.bridgeId);
    if (!bridgeId) {
      return { ok: true, stopped: false };
    }
    const session = sessions.get(bridgeId);
    if (!session) {
      return { ok: true, stopped: false };
    }
    await stopSession(session);
    if (sessions.get(bridgeId) === session) {
      sessions.delete(bridgeId);
    }
    return { ok: true, stopped: true };
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
      const params = asRecord(raw);
      const action = readString(params.action);
      let result: unknown;
      switch (action) {
        case "setup":
          options.assertAudioAvailable(10_000);
          result = { ok: true };
          break;
        case "start":
          result = startBrowser(params);
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
          result = pushAudio(params);
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
