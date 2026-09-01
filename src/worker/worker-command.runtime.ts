import { realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { toErrorObject } from "../infra/errors.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import { parseWorkerLaunchDescriptor, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { parseWorkerProcessRequest, type WorkerProcessResult } from "./worker-process-protocol.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";

type RunWorkerCommandOptions = {
  input: Readable;
  lifetime?: WorkerCommandLifetime;
  output: Writable;
  browserRuntime?: WorkerBrowserRuntime;
  managed?: boolean;
};

export type WorkerCommandLifetime = {
  dispose: () => void;
  reportConnectionFailure: (cause: string | undefined) => void;
  signal: AbortSignal;
  started: Promise<boolean>;
  terminateOwnedTree: () => void;
};

async function runManagedWorkerCommand(
  options: RunWorkerCommandOptions,
  signal: AbortSignal,
): Promise<void> {
  let environment: Awaited<ReturnType<typeof createWorkerRuntimeEnvironment>> | undefined;
  let binding: string | undefined;
  let lastTurnId: string | undefined;
  let active: { turnId: string; controller: AbortController } | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  let chunks: Buffer[] = [];
  let byteLength = 0;
  let removeListeners = () => {};

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        if (closed) {
          return;
        }
        const failure =
          error === undefined ? undefined : toErrorObject(error, "managed worker command failed");
        closed = true;
        active?.controller.abort(failure ?? new Error("worker supervisor input closed"));
        options.input.destroy();
        options.output.destroy();
        if (failure) {
          reject(failure);
        } else {
          resolve();
        }
      };
      const onLine = (line: Buffer) => {
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          throw new Error("managed worker request is not valid JSON");
        }
        const request = parseWorkerProcessRequest(value);
        if (request.type === "cancel") {
          if (active?.turnId === request.turnId) {
            active.controller.abort(new Error("worker turn cancelled"));
          }
          return;
        }
        if (active || lastTurnId === request.turnId) {
          throw new Error("managed worker turn is already active or was already executed");
        }
        // The node turn journal owns replay history; retain only the immediate
        // transport duplicate here, then require fresh Gateway admission.
        lastTurnId = request.turnId;
        const current = { turnId: request.turnId, controller: new AbortController() };
        active = current;
        running = (async () => {
          const descriptor = request.descriptor;
          const workspaceDir = await realpath(descriptor.assignment.workspaceDir);
          const workerContainmentRoot = await realpath(
            descriptor.assignment.workerContainmentRoot ?? workspaceDir,
          );
          const nextBinding = JSON.stringify({
            environmentId: descriptor.admission.environmentId,
            sessionId: descriptor.admission.sessionId,
            ownerEpoch: descriptor.admission.ownerEpoch,
            agentId: descriptor.assignment.agentId,
            permissionMode: descriptor.assignment.permissionMode,
            workspaceDir,
            workerContainmentRoot,
          });
          if (binding !== undefined && binding !== nextBinding) {
            throw new Error("managed worker environment binding changed; relaunch required");
          }
          binding = nextBinding;
          if (closed) {
            return;
          }
          environment ??= await createWorkerRuntimeEnvironment(descriptor.admission.sessionId);
          if (closed) {
            return;
          }
          const result = await runWorkerDescriptor(
            {
              ...descriptor,
              assignment:
                descriptor.assignment.permissionMode === undefined
                  ? { ...descriptor.assignment, workspaceDir }
                  : {
                      ...descriptor.assignment,
                      workspaceDir,
                      permissionMode: descriptor.assignment.permissionMode,
                      workerContainmentRoot,
                    },
            },
            {
              environmentStateDir: environment.stateDir,
              signal: current.controller.signal,
              ...(options.lifetime
                ? { onConnectionFailure: options.lifetime.reportConnectionFailure }
                : {}),
              ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
            },
          );
          if (closed) {
            return;
          }
          const retainWorker =
            (result.status === "completed" || result.status === "failed") &&
            getActiveBackgroundExecSessionCount() > 0;
          const response: WorkerProcessResult = {
            type: "result",
            turnId: current.turnId,
            result,
            retainWorker,
          };
          if (retainWorker) {
            active = undefined;
          }
          await new Promise<void>((resolveWrite, rejectWrite) => {
            const onClose = () => rejectWrite(new Error("managed worker result output closed"));
            options.output.once("close", onClose);
            options.output.write(`${JSON.stringify(response)}\n`, (error) => {
              options.output.off("close", onClose);
              if (error) {
                rejectWrite(error);
              } else {
                resolveWrite();
              }
            });
          });
          if (!retainWorker) {
            active = undefined;
            finish();
          }
        })().catch(finish);
      };
      const onData = (raw: unknown) => {
        if (closed) {
          return;
        }
        try {
          const chunk =
            typeof raw === "string"
              ? Buffer.from(raw)
              : raw instanceof Uint8Array
                ? Buffer.from(raw)
                : undefined;
          if (!chunk) {
            throw new Error("managed worker input must be bytes");
          }
          let offset = 0;
          while (offset < chunk.length) {
            if (closed) {
              break;
            }
            const newline = chunk.indexOf(10, offset);
            const end = newline === -1 ? chunk.length : newline;
            byteLength += end - offset;
            if (byteLength > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
              throw new Error("managed worker request exceeds the protocol payload limit");
            }
            chunks.push(chunk.subarray(offset, end));
            if (newline === -1) {
              break;
            }
            const line = Buffer.concat(chunks, byteLength);
            chunks = [];
            byteLength = 0;
            onLine(line);
            offset = newline + 1;
          }
        } catch (error) {
          finish(error);
        }
      };
      const onEnd = () => finish();
      const onAbort = () => finish(signal.reason);
      options.input.on("data", onData);
      options.input.once("end", onEnd);
      options.input.once("close", onEnd);
      options.input.once("error", finish);
      options.output.once("error", finish);
      signal.addEventListener("abort", onAbort, { once: true });
      removeListeners = () => {
        options.input.off("data", onData);
        options.input.off("end", onEnd);
        options.input.off("close", onEnd);
        options.input.off("error", finish);
        options.output.off("error", finish);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
      } else if (options.input.readableEnded || options.input.destroyed) {
        onEnd();
      }
    });
  } finally {
    chunks = [];
    try {
      await running;
      await environment?.close();
    } finally {
      removeListeners();
    }
  }
}

async function readLaunchDescriptor(input: Readable): Promise<WorkerLaunchDescriptor> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const rawChunk of input as AsyncIterable<unknown>) {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : rawChunk instanceof Uint8Array
          ? Buffer.from(rawChunk)
          : undefined;
    if (!chunk) {
      throw new Error("worker launch descriptor input must be bytes");
    }
    byteLength += chunk.byteLength;
    if (byteLength > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
      throw new Error("worker launch descriptor exceeds the protocol payload limit");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) {
    throw new Error("worker launch descriptor is required on stdin");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("worker launch descriptor is not valid JSON", { cause: error });
  }
  return parseWorkerLaunchDescriptor(decoded);
}

/** Process shell for `openclaw worker`: stdin descriptor in, JSON result out, signals abort the run. */
export async function runWorkerCommand(options: RunWorkerCommandOptions): Promise<void> {
  const abortController = new AbortController();
  const stop = () => abortController.abort(new Error("worker interrupted"));
  let lifetimeEnded = false;
  const stopForLifetime = () => {
    if (lifetimeEnded || !options.lifetime) {
      return;
    }
    lifetimeEnded = true;
    abortController.abort(
      options.lifetime.signal.reason ?? new Error("worker supervisor lifetime ended"),
    );
    options.lifetime.terminateOwnedTree();
  };
  try {
    const [descriptor, started] = await Promise.all([
      options.managed ? undefined : readLaunchDescriptor(options.input),
      options.lifetime?.started ?? true,
    ]);
    if (!started) {
      return;
    }
    options.lifetime?.signal.addEventListener("abort", stopForLifetime, { once: true });
    if (options.lifetime?.signal.aborted) {
      stopForLifetime();
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (!descriptor) {
      await runManagedWorkerCommand(options, abortController.signal);
      return;
    }
    const result = await runWorkerDescriptor(descriptor, {
      signal: abortController.signal,
      ...(options.lifetime
        ? { onConnectionFailure: options.lifetime.reportConnectionFailure }
        : {}),
      ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
    });
    const encoded = `${JSON.stringify(result)}\n`;
    options.output.write(encoded);
  } finally {
    options.lifetime?.signal.removeEventListener("abort", stopForLifetime);
    options.lifetime?.dispose();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
