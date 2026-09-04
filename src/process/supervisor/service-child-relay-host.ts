import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Duplex, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { toErrorObject } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { onDecodedOutput } from "../decoded-output.js";
import { prepareSecretInputStdio } from "../spawn-secret-input.js";
import { createManagedChildStdin } from "./adapters/child-stdin.js";
import { toStringEnv } from "./adapters/env.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildControlMessage,
  type ServiceChildRelayMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";
import type { ProcessAdapterConstruction, SpawnProcessAdapter, SpawnSecretInput } from "./types.js";

type ServiceChildRelayAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  waitForExtinction: () => Promise<void>;
};
type AuthorityState = "starting" | "active" | "closing" | "closed" | "identity-lost";
type StdioEntry = "ignore" | "inherit" | "ipc" | "pipe" | number;

const PUSHED_OUTPUT_BUFFER_LIMIT_BYTES = 256 * 1024;
const CONTROL_PENDING_LINE_LIMIT_BYTES = 256 * 1024;

function readChildMessage(raw: unknown): ServiceChildRelayMessage | ServiceChildAnchorMessage {
  // SAFETY: the spawned relay or Job anchor is the sole writer on each private protocol channel.
  return raw as ServiceChildRelayMessage | ServiceChildAnchorMessage;
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

function createOutputRelay(stream?: Readable) {
  const listeners = new Set<(chunk: string) => void>();
  const rawListeners = new Set<(chunk: Buffer) => void>();
  const pending: Array<string | Buffer> = [];
  let pendingBytes = 0;
  let active = false;
  let ended = false;
  const deliver = (chunk: string | Buffer) => {
    if (typeof chunk === "string") {
      listeners.forEach((listener) => listener(chunk));
    } else {
      rawListeners.forEach((listener) => listener(chunk));
    }
  };
  const activate = (keepOutput: boolean) => {
    if (active) {
      return;
    }
    active = true;
    if (keepOutput) {
      pending.forEach(deliver);
    }
    pending.length = 0;
    pendingBytes = 0;
    stream?.resume();
  };
  const push = (chunk: string | Buffer) => {
    if (active) {
      deliver(chunk);
      return true;
    }
    const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (!stream && pendingBytes + chunkBytes > PUSHED_OUTPUT_BUFFER_LIMIT_BYTES) {
      return false;
    }
    pending.push(chunk);
    if (!stream || Buffer.isBuffer(chunk)) {
      pendingBytes += chunkBytes;
    }
    if (stream && pendingBytes >= stream.readableHighWaterMark) {
      // POSIX can retain later output in its native pipe until subscription.
      stream.pause();
    }
    return true;
  };
  const end = () => {
    ended = true;
  };
  if (stream) {
    onDecodedOutput(stream, push, push);
    stream.once("end", end);
    stream.once("close", end);
  }
  return {
    get ended() {
      return ended;
    },
    push,
    end,
    subscribe: (listener: (chunk: string) => void, onRaw?: (chunk: Buffer) => void) => {
      listeners.add(listener);
      if (onRaw) {
        rawListeners.add(onRaw);
      }
      activate(true);
    },
    drain: () => activate(false),
    clear: () => {
      listeners.clear();
      rawListeners.clear();
      pending.length = 0;
      pendingBytes = 0;
    },
  };
}

export async function createServiceChildRelayAdapter(
  params: ProcessAdapterConstruction & {
    command: string;
    args: string[];
    argv0?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdinMode: "inherit" | "pipe-open" | "pipe-closed";
    input?: string;
    secretInput?: SpawnSecretInput;
    oomScoreWrapperSelected: boolean;
    windowsShellCommand?: string;
  },
): Promise<ServiceChildRelayAdapter> {
  const generation = randomUUID();
  const useWindowsJobAnchor =
    process.platform === "win32" && params.windowsShellCommand !== undefined;
  const workerUrl = resolveRuntimeWorkerUrl(
    useWindowsJobAnchor
      ? runtimeProcessEntrypoints.serviceChildWindowsJobAnchor
      : runtimeProcessEntrypoints.serviceChildRelay,
  );
  const stdio: StdioEntry[] = useWindowsJobAnchor
    ? ["ignore", "ignore", "ignore"]
    : [params.stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  using secretDelivery = prepareSecretInputStdio(
    stdio,
    useWindowsJobAnchor ? undefined : params.secretInput,
  );
  const controlFd = useWindowsJobAnchor ? undefined : reserveStdioEntry(stdio, "pipe");
  reserveStdioEntry(stdio, "ipc");

  if (params.abortSignal?.aborted) {
    throw new Error("service child construction aborted");
  }
  params.assertCurrent?.();
  const child = spawn(process.execPath, resolveRuntimeWorkerArgv(workerUrl), {
    stdio,
    // A detached Windows Job owner survives host loss long enough to clean up.
    // Keep its child handle referenced so an idle host can finish admission and lineage cleanup.
    detached: useWindowsJobAnchor,
    windowsHide: true,
    env: process.env,
  });
  const extinctionCompletion = createDeferredCore();
  void extinctionCompletion.promise.catch(() => {});
  params.onSpawnCleanup?.(extinctionCompletion.promise);

  // SAFETY: a defined controlFd was reserved as a pipe in this exact spawn stdio array.
  const control = controlFd === undefined ? null : (child.stdio[controlFd] as Duplex | null);
  if (!child.connected || (!useWindowsJobAnchor && (!control || !child.stdout || !child.stderr))) {
    child.kill("SIGKILL");
    const error = new Error(
      "service child cleanup identity lost: lifecycle channels were not created",
    );
    extinctionCompletion.reject(error);
    throw error;
  }
  const stdoutRelay = createOutputRelay(child.stdout ?? undefined);
  const stderrRelay = createOutputRelay(child.stderr ?? undefined);
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});

  let state: AuthorityState = "starting";
  let commandPid: number | undefined;
  let outboundSequence = 0;
  let inboundSequence = 0;
  let rootResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resultError: Error | undefined;
  let closingReceipt = false;
  let controlError: Error | undefined;
  let childError: Error | undefined;
  let childDisconnected = false;
  let childExited = false;
  let requestedSignal: "SIGTERM" | "SIGKILL" | undefined;
  let waitError: Error | undefined;
  const startup = createDeferredCore();
  const resultCompletion = createDeferredCore<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  // Failures can arrive before either public wait is requested.
  void startup.promise.catch(() => {});
  void resultCompletion.promise.catch(() => {});
  const constructionAbort = createDeferredCore<never>();
  void constructionAbort.promise.catch(() => {});
  let startupErrorAckDelivery: Promise<void> | undefined;

  const settleWait = () => {
    const error = waitError ?? resultError;
    if (error) {
      resultCompletion.reject(error);
      return;
    }
    if (!rootResult || !stdoutRelay.ended || !stderrRelay.ended) {
      return;
    }
    if (requestedSignal && state !== "closed") {
      return;
    }
    resultCompletion.resolve(rootResult);
  };

  // Root result and output EOF cross different channels. Decoder flush listeners were
  // registered first, so settlement observes both final text tails before disposal.
  child.stdout?.once("end", settleWait);
  child.stdout?.once("close", settleWait);
  child.stderr?.once("end", settleWait);
  child.stderr?.once("close", settleWait);

  const loseIdentity = (message: string) => {
    if (state === "closed" || state === "identity-lost") {
      return;
    }
    state = "identity-lost";
    waitError = new Error(`service child cleanup identity lost: ${message}`);
    if (!commandPid) {
      startup.reject(waitError);
    }
    settleWait();
    extinctionCompletion.reject(waitError);
  };

  const sendChildMessage = (
    message: ServiceChildStart | ServiceChildControlMessage,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!child.connected) {
        reject(new Error("service child lifecycle IPC is closed"));
        return;
      }
      child.send(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

  const sendControlMessage = (message: ServiceChildControlMessage): Promise<void> => {
    if (useWindowsJobAnchor) {
      return sendChildMessage(message);
    }
    return new Promise((resolve, reject) => {
      if (!control || control.destroyed) {
        reject(new Error("service child control pipe is closed"));
        return;
      }
      control.write(encodeServiceChildMessage(message), "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };

  const onConstructionAbort = () => {
    child.kill("SIGKILL");
    // The anchor may still be cleaning its group after relay loss. Keep that
    // uncertainty observable; a later receipt cannot prove this aborted startup extinct.
    loseIdentity("construction aborted");
    constructionAbort.reject(waitError ?? new Error("service child construction aborted"));
  };
  const removeConstructionAbortListener = () => {
    params.abortSignal?.removeEventListener("abort", onConstructionAbort);
  };

  const finishAuthorityClose = (missingReceiptError: string) => {
    if (!closingReceipt) {
      loseIdentity(missingReceiptError);
      return;
    }
    state = "closed";
    if (!rootResult && !resultError && !waitError) {
      rootResult = { code: null, signal: requestedSignal ?? null };
    }
    settleWait();
    extinctionCompletion.resolve();
  };

  const handleAnchorMessage = (message: ServiceChildAnchorMessage) => {
    if (message.generation !== generation || message.sequence <= inboundSequence) {
      loseIdentity("stale anchor generation or sequence");
      return;
    }
    inboundSequence = message.sequence;
    if (message.type === "ready" && state === "starting") {
      // Ready is not construction-complete: secret delivery can still be
      // blocked. Keep abort protection until the adapter returns.
      commandPid = message.commandPid;
      state = "active";
      startup.resolve();
    } else if (message.type === "root-result") {
      if (!resultError) {
        rootResult ??= { code: message.code, signal: message.signal };
      }
      settleWait();
    } else if (message.type === "result-error") {
      resultError ??= new Error(`service child result unavailable: ${message.error}`);
      settleWait();
    } else if (message.type === "output") {
      if (!(message.stream === "stdout" ? stdoutRelay : stderrRelay).push(message.chunk)) {
        resultError ??= new Error(
          `service child ${message.stream} exceeded its pre-subscription buffer`,
        );
        settleWait();
      }
    } else if (message.type === "output-end") {
      (message.stream === "stdout" ? stdoutRelay : stderrRelay).end();
      settleWait();
    } else if (message.type === "closing") {
      closingReceipt = true;
      state = "closing";
    } else if (message.type === "startup-error") {
      if (useWindowsJobAnchor) {
        startup.reject(new Error(message.error));
      } else {
        loseIdentity(message.error);
      }
      outboundSequence += 1;
      startupErrorAckDelivery = sendControlMessage({
        type: "startup-error-ack",
        generation,
        sequence: outboundSequence,
      });
      void startupErrorAckDelivery.catch((error: unknown) =>
        loseIdentity(toErrorObject(error, "startup error acknowledgement failed").message),
      );
    }
  };

  if (control) {
    let pending = "";
    let pendingBytes = 0;
    let decoder = new StringDecoder("utf8");
    const rejectControlLine = () => {
      loseIdentity("control pipe pending line exceeded cap");
      child.kill("SIGKILL");
      pending = "";
      pendingBytes = 0;
      decoder = new StringDecoder("utf8");
    };
    const parseControlLine = (fragment: Buffer): boolean => {
      const line = pending + decoder.end(fragment);
      pending = "";
      pendingBytes = 0;
      decoder = new StringDecoder("utf8");
      try {
        const message = readChildMessage(JSON.parse(line));
        if (!("sequence" in message)) {
          throw new Error("invalid anchor message");
        }
        handleAnchorMessage(message);
      } catch {
        loseIdentity("invalid anchor message");
      }
      return true;
    };
    // Keep raw bytes until the line cap accepts each fragment.
    // String mode decodes a complete oversized frame before this parser can reject it.
    control.on("data", (chunk: Buffer) => {
      let offset = 0;
      for (;;) {
        const searchLength = CONTROL_PENDING_LINE_LIMIT_BYTES - pendingBytes + 1;
        const boundedChunk = chunk.subarray(offset, offset + searchLength);
        const newline = boundedChunk.indexOf(0x0a);
        if (newline < 0) {
          if (boundedChunk.length === searchLength) {
            rejectControlLine();
          } else {
            pending += decoder.write(boundedChunk);
            pendingBytes += boundedChunk.length;
          }
          return;
        }
        if (!parseControlLine(boundedChunk.subarray(0, newline))) {
          return;
        }
        offset += newline + 1;
      }
    });
    control.once("close", () => {
      finishAuthorityClose(
        childError?.message ??
          controlError?.message ??
          "anchor channel closed without a matching closing receipt",
      );
    });
    control.on("error", (error) => {
      controlError ??= error;
    });
  }

  child.on("message", (raw: unknown) => {
    const message = readChildMessage(raw);
    if (!message || typeof message !== "object") {
      if (useWindowsJobAnchor) {
        loseIdentity("invalid anchor message");
      }
      return;
    }
    if (useWindowsJobAnchor) {
      if (!("sequence" in message)) {
        loseIdentity("invalid anchor message");
        return;
      }
      handleAnchorMessage(message);
      return;
    }
    if (message.generation !== generation) {
      return;
    }
    if (message.type === "relay-error") {
      loseIdentity(message.error);
    }
  });
  child.once("error", (error) => {
    // The direct control pipe may still contain the anchor's authoritative closing receipt.
    childError ??= error;
  });
  const finishWindowsAuthority = () => {
    if (!useWindowsJobAnchor || !childDisconnected || !childExited) {
      return;
    }
    finishAuthorityClose(
      childError?.message ?? "Windows service child anchor exited without a closing receipt",
    );
  };
  child.once("disconnect", () => {
    childDisconnected = true;
    finishWindowsAuthority();
  });
  child.once("exit", () => {
    childExited = true;
    removeConstructionAbortListener();
    if (useWindowsJobAnchor) {
      finishWindowsAuthority();
    }
  });

  const start: ServiceChildStart = {
    type: "start",
    generation,
    command: params.command,
    args: params.args,
    argv0: params.argv0,
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdinMode: params.stdinMode,
    secretFd: params.secretInput?.fd,
    controlFd,
    windowsShellCommand: params.windowsShellCommand,
  };
  const stdin = createManagedChildStdin(child.stdin);
  params.abortSignal?.addEventListener("abort", onConstructionAbort, { once: true });
  try {
    params.assertCurrent?.();
    if (params.abortSignal?.aborted) {
      onConstructionAbort();
    }
    await Promise.race([sendChildMessage(start), constructionAbort.promise]);
    params.assertCurrent?.();
    const [startupResult, secretDeliveryResult] = await Promise.allSettled([
      startup.promise,
      secretDelivery?.deliverTo(child, { abortSignal: params.abortSignal }),
    ]);
    const startupError = startupResult.status === "rejected" ? startupResult.reason : undefined;
    const secretDeliveryError =
      secretDeliveryResult.status === "rejected" ? secretDeliveryResult.reason : undefined;
    // Preserve admission failure over the secret pipe it closes as a consequence.
    if (startupError !== undefined || secretDeliveryError !== undefined) {
      if (useWindowsJobAnchor && startupError !== undefined) {
        await startupErrorAckDelivery;
        await extinctionCompletion.promise;
      }
      throw startupError ?? secretDeliveryError;
    }
    if (params.abortSignal?.aborted || waitError) {
      throw waitError ?? new Error("service child construction aborted");
    }
    params.assertCurrent?.();
    if (params.input !== undefined) {
      stdin?.write(params.input);
      stdin?.end();
    } else if (params.stdinMode === "pipe-closed") {
      stdin?.end();
    }
  } catch (error) {
    stdoutRelay.drain();
    stderrRelay.drain();
    child.kill("SIGKILL");
    throw error;
  } finally {
    removeConstructionAbortListener();
  }

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    // A closing receipt retires cancellation; channel/anchor exit still owns extinction.
    if (state !== "active") {
      return;
    }
    const normalized = signal === "SIGTERM" ? "SIGTERM" : "SIGKILL";
    requestedSignal = normalized;
    outboundSequence += 1;
    // The host never converts the diagnostic command PID into group authority.
    void sendControlMessage({
      type: "cancel",
      generation,
      sequence: outboundSequence,
      signal: normalized,
    }).catch((error: unknown) => {
      // Delivery can fail after the anchor has already sent its closing receipt.
      if (state === "active") {
        loseIdentity(toErrorObject(error, "service child cancellation failed").message);
      }
    });
  };

  return {
    pid: commandPid,
    stdin,
    oomScoreWrapperSelected: params.oomScoreWrapperSelected,
    supportsRawOutput: !useWindowsJobAnchor,
    onStdout: stdoutRelay.subscribe,
    onStderr: stderrRelay.subscribe,
    wait: async () => {
      // A caller may intentionally ignore one stream; wait still owns draining it.
      stdoutRelay.drain();
      stderrRelay.drain();
      settleWait();
      return await resultCompletion.promise;
    },
    waitForExtinction: async () => await extinctionCompletion.promise,
    kill,
    dispose: () => {
      stdoutRelay.clear();
      stderrRelay.clear();
    },
  };
}
