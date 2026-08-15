import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Duplex, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "../../infra/errors.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { onDecodedOutput } from "../decoded-output.js";
import { addSecretInputStdio, writeSecretInputToChild } from "../spawn-secret-input.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildRelayMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";
import type { ManagedRunStdin, SpawnProcessAdapter, SpawnSecretInput } from "./types.js";

type ServiceAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;
type AuthorityState = "starting" | "active" | "closing" | "closed" | "identity-lost";
type StdioEntry = "ignore" | "inherit" | "ipc" | "pipe" | number;

const retainedRelays = new Map<string, ChildProcess>();

function runtimeArgv(url: URL): string[] {
  return url.pathname.endsWith(".ts")
    ? ["--import", "tsx", fileURLToPath(url)]
    : [fileURLToPath(url)];
}

function reserveStdioEntry(stdio: StdioEntry[], value: StdioEntry): number {
  let fd = 3;
  while (stdio[fd] !== undefined && stdio[fd] !== "ignore") {
    fd += 1;
  }
  while (stdio.length <= fd) {
    stdio.push("ignore");
  }
  stdio[fd] = value;
  return fd;
}

function createManagedStdin(stream: Writable | null): ManagedRunStdin | undefined {
  if (!stream) {
    return undefined;
  }
  let ended = stream.writableEnded || stream.writableFinished;
  let destroyed = stream.destroyed;
  stream.once("finish", () => {
    ended = true;
  });
  stream.once("close", () => {
    ended = true;
    destroyed = true;
  });
  stream.once("error", () => {
    destroyed = true;
  });
  return {
    get destroyed() {
      return destroyed || stream.destroyed;
    },
    get writable() {
      return !destroyed && !ended && stream.writable;
    },
    get writableEnded() {
      return ended || stream.writableEnded;
    },
    get writableFinished() {
      return stream.writableFinished;
    },
    write(data, callback) {
      if (destroyed || ended || !stream.writable) {
        callback?.(new Error("stdin is not writable"));
        return;
      }
      try {
        stream.write(data, callback);
      } catch (error) {
        callback?.(toErrorObject(error, "stdin write failed"));
      }
    },
    end() {
      ended = true;
      stream.end();
    },
    destroy() {
      ended = true;
      destroyed = true;
      stream.destroy();
    },
  };
}

export async function createServiceChildRelayAdapter(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinMode: "inherit" | "pipe-open" | "pipe-closed";
  input?: string;
  secretInput?: SpawnSecretInput;
  oomScoreWrapperSelected: boolean;
}): Promise<ServiceAdapter> {
  const generation = randomUUID();
  const relayUrl = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "service-child-relay",
    distWorkerPath: "process/supervisor/service-child-relay.js",
  });
  const stdio: StdioEntry[] = [params.stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  addSecretInputStdio(stdio as Parameters<typeof addSecretInputStdio>[0], params.secretInput);
  const controlFd = reserveStdioEntry(stdio, "pipe");
  reserveStdioEntry(stdio, "ipc");

  const relay = spawn(process.execPath, runtimeArgv(relayUrl), {
    stdio,
    detached: false,
    windowsHide: true,
    env: process.env,
  });
  retainedRelays.set(generation, relay);
  relay.unref();

  const control = relay.stdio[controlFd] as Duplex | null;
  if (!relay.connected || !control || !relay.stdout || !relay.stderr) {
    relay.kill("SIGKILL");
    retainedRelays.delete(generation);
    throw new Error("service child relay channels were not created");
  }
  const { stdout, stderr } = relay;

  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  onDecodedOutput(stdout, (text) => {
    for (const listener of stdoutListeners) {
      listener(text);
    }
  });
  onDecodedOutput(stderr, (text) => {
    for (const listener of stderrListeners) {
      listener(text);
    }
  });
  stdout.on("error", () => {});
  stderr.on("error", () => {});

  let state: AuthorityState = "starting";
  let commandPid: number | undefined;
  let outboundSequence = 0;
  let inboundSequence = 0;
  let rootResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let closingReceipt = false;
  let requestedSignal: "SIGTERM" | "SIGKILL" | undefined;
  let waitError: Error | undefined;
  let resolveStartup!: () => void;
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  let resolveWait:
    | ((result: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  let waitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let waitSettled = false;

  const settleWait = () => {
    if (waitSettled) {
      return;
    }
    if (waitError) {
      waitSettled = true;
      rejectWait?.(waitError);
      return;
    }
    if (
      !rootResult ||
      !(stdout.readableEnded || stdout.closed) ||
      !(stderr.readableEnded || stderr.closed)
    ) {
      return;
    }
    if (requestedSignal && state !== "closed") {
      return;
    }
    waitSettled = true;
    resolveWait?.(rootResult);
  };

  // Root result and output EOF cross different channels. Decoder flush listeners were
  // registered first, so settlement observes both final text tails before disposal.
  stdout.once("end", settleWait);
  stdout.once("close", settleWait);
  stderr.once("end", settleWait);
  stderr.once("close", settleWait);

  const loseIdentity = (message: string) => {
    if (state === "closed" || state === "identity-lost") {
      return;
    }
    state = "identity-lost";
    waitError = new Error(`service child cleanup identity lost: ${message}`);
    if (!commandPid) {
      rejectStartup(waitError);
    }
    settleWait();
  };

  let pending = "";
  control.setEncoding("utf8");
  control.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let message: ServiceChildAnchorMessage;
      try {
        message = JSON.parse(line) as ServiceChildAnchorMessage;
      } catch {
        loseIdentity("invalid anchor message");
        continue;
      }
      if (message.generation !== generation || message.sequence <= inboundSequence) {
        loseIdentity("stale anchor generation or sequence");
        continue;
      }
      inboundSequence = message.sequence;
      if (message.type === "ready" && state === "starting") {
        commandPid = message.commandPid;
        state = "active";
        resolveStartup();
      } else if (message.type === "root-result") {
        rootResult ??= { code: message.code, signal: message.signal };
        settleWait();
      } else if (message.type === "closing") {
        closingReceipt = true;
        state = "closing";
      } else if (message.type === "startup-error") {
        loseIdentity(message.error);
        outboundSequence += 1;
        control.write(
          encodeServiceChildMessage({
            type: "startup-error-ack",
            generation,
            sequence: outboundSequence,
          }),
        );
      }
    }
  });
  control.once("close", () => {
    // Correlation is not authority: only the receipt on this exact channel followed by
    // its closure proves the in-group anchor disabled every future cleanup action.
    if (!closingReceipt) {
      loseIdentity("anchor channel closed without a matching closing receipt");
      return;
    }
    state = "closed";
    rootResult ??= { code: null, signal: requestedSignal ?? null };
    settleWait();
  });
  control.on("error", (error) => {
    loseIdentity(error.message);
  });

  relay.on("message", (raw: unknown) => {
    const message = raw as ServiceChildRelayMessage;
    if (!message || typeof message !== "object" || message.generation !== generation) {
      return;
    }
    if (message.type === "relay-error") {
      loseIdentity(message.error);
    } else if (message.type === "anchor-exit" && state !== "closed" && !closingReceipt) {
      loseIdentity(`anchor exited (${message.code ?? message.signal ?? "unknown"})`);
    }
  });
  relay.once("error", (error) => {
    loseIdentity(error.message);
  });
  relay.once("exit", (code, signal) => {
    retainedRelays.delete(generation);
    if (state !== "closed" && !closingReceipt) {
      loseIdentity(`relay exited (${code ?? signal ?? "unknown"})`);
    }
  });

  const start: ServiceChildStart = {
    type: "start",
    generation,
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env as Record<string, string> | undefined,
    stdinMode: params.stdinMode,
    secretFd: params.secretInput?.fd,
    controlFd,
  };
  relay.send(start);

  const [startupResult, secretDeliveryResult] = await Promise.allSettled([
    startup,
    writeSecretInputToChild(relay, params.secretInput),
  ]);
  const startupError = startupResult.status === "rejected" ? startupResult.reason : undefined;
  const secretDeliveryError =
    secretDeliveryResult.status === "rejected" ? secretDeliveryResult.reason : undefined;
  if (startupError !== undefined || secretDeliveryError !== undefined) {
    relay.kill("SIGKILL");
    retainedRelays.delete(generation);
    // Startup owns command admission, so its exact failure wins over a concurrent
    // backpressured secret pipe closing as a consequence of that failed admission.
    throw startupError ?? secretDeliveryError;
  }

  const stdin = createManagedStdin(relay.stdin);
  if (params.input !== undefined) {
    stdin?.write(params.input);
    stdin?.end();
  } else if (params.stdinMode === "pipe-closed") {
    stdin?.end();
  }

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    if (state === "closed" || state === "identity-lost") {
      return;
    }
    const normalized = signal === "SIGTERM" ? "SIGTERM" : "SIGKILL";
    requestedSignal = normalized;
    outboundSequence += 1;
    // The host never converts the diagnostic command PID into group authority.
    control.write(
      encodeServiceChildMessage({
        type: "cancel",
        generation,
        sequence: outboundSequence,
        signal: normalized,
      }),
    );
  };

  return {
    pid: commandPid,
    stdin,
    oomScoreWrapperSelected: params.oomScoreWrapperSelected,
    onStdout: (listener) => stdoutListeners.add(listener),
    onStderr: (listener) => stderrListeners.add(listener),
    wait: async () => {
      settleWait();
      if (waitError) {
        throw waitError;
      }
      if (rootResult && waitSettled) {
        return rootResult;
      }
      waitPromise ??= new Promise((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
      });
      return await waitPromise;
    },
    kill,
    dispose: () => {
      stdoutListeners.clear();
      stderrListeners.clear();
    },
  };
}
