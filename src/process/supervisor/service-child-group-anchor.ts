import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createDeferredCore } from "../../shared/deferred.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import { hasLiveOwnedProcessGroupMembers } from "./service-child-group-ownership.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildAnchorPayload,
  type ServiceChildControlMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";

const LINEAGE_EXIT_OBSERVATION_MS = 100;

type AnchorState = "starting" | "active" | "closing" | "closed";
type StdioEntry = "ignore" | "inherit" | "pipe" | number;

function commandStdio(start: ServiceChildStart): {
  stdio: StdioEntry[];
  lineageFd: number;
} {
  const stdio: StdioEntry[] = [start.stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  if (start.secretFd !== undefined) {
    while (stdio.length <= start.secretFd) {
      stdio.push("ignore");
    }
    stdio[start.secretFd] = start.secretFd;
  }
  let lineageFd = 3;
  while (stdio[lineageFd] !== undefined && stdio[lineageFd] !== "ignore") {
    lineageFd += 1;
  }
  while (stdio.length <= lineageFd) {
    stdio.push("ignore");
  }
  stdio[lineageFd] = "pipe";
  return { stdio, lineageFd };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function runServiceChildGroupAnchor(): void {
  let start: ServiceChildStart | undefined;
  let state: AnchorState = "starting";
  let sequence = 0;
  let lastHostSequence = 0;
  let command: ChildProcess | undefined;
  let control: Socket | WriteStream | undefined;
  let rootSettlementStarted = false;
  let rootResultDelivery: Promise<void> | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let stdoutDrained = false;
  let stderrDrained = false;
  let lineageClosed = false;
  let forceCleanup = false;
  const forceCleanupRequested = createDeferredCore();
  const lineageDone = createDeferredCore();
  const rootExited = createDeferredCore();
  const rootSettledDone = createDeferredCore();
  const startupErrorAcknowledged = createDeferredCore();

  const send = async (message: ServiceChildAnchorPayload) => {
    if (!start || !control || control.destroyed) {
      return;
    }
    sequence += 1;
    await new Promise<void>((resolve) => {
      const framed = {
        ...message,
        generation: start!.generation,
        sequence,
      };
      control!.write(
        encodeServiceChildMessage(framed as ServiceChildAnchorMessage), // SAFETY: typed payload plus live envelope forms the protocol union.
        () => resolve(),
      );
    });
  };

  const closeAuthority = async (
    reason: Extract<ServiceChildAnchorMessage, { type: "closing" }>["reason"],
    hardKill: boolean,
  ) => {
    if (!start || state === "closed") {
      return;
    }
    state = "closed";
    if (hardKill) {
      // Killing the observer cannot confirm descendant death. Missing closure
      // leaves the host's existing ownership receipt uncertain.
      process.kill(0, "SIGKILL");
      return;
    }
    await send({ type: "closing", reason });
    control?.end(() => process.exit(0));
  };

  const reportStartupFailure = async (error: string) => {
    await send({ type: "startup-error", error });
    // A write callback only proves kernel acceptance. Keep the exact anchor alive until the
    // host records the authoritative spawn failure and acknowledges it on this same channel.
    await startupErrorAcknowledged.promise;
    await closeAuthority("lineage-lost", false);
  };

  const requestCleanup = async (
    reason: "cancel" | "lineage-lost" | "parent-lost",
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ) => {
    if (!start || state === "closed") {
      return;
    }
    if (state === "closing") {
      forceCleanup ||= signal === "SIGKILL";
      if (forceCleanup) {
        forceCleanupRequested.resolve();
      }
      return;
    }
    state = "closing";
    forceCleanup = signal === "SIGKILL";
    const cleanupDeadline = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
    const termGraceDone = delay(GRACEFUL_CANCEL_TIMEOUT_MS);
    if (!forceCleanup) {
      // The anchor catches its own signal while every command-group member receives it.
      process.kill(0, "SIGTERM");
      await Promise.race([lineageDone.promise, termGraceDone, forceCleanupRequested.promise]);
    }
    if (state !== "closing" || !start) {
      return;
    }
    if (lineageClosed && !rootExit && !forceCleanup) {
      // Cleanup already owns the group. A normal root exit may race lineage EOF,
      // but the short observation window must not replace the configured TERM grace.
      await Promise.race([rootExited.promise, termGraceDone, forceCleanupRequested.promise]);
    }
    if (state !== "closing" || !start) {
      return;
    }
    if (rootExit && !forceCleanup) {
      // Output can outlive lineage and the root. It may preserve the authentic root
      // result only within the existing TERM grace, and KILL must wake this wait.
      await Promise.race([rootSettledDone.promise, termGraceDone, forceCleanupRequested.promise]);
      if (state !== "closing" || !start) {
        return;
      }
    }
    for (;;) {
      // Process and control events can change these facts during the awaited observation.
      if (forceCleanup || !rootExit || !stdoutDrained || !stderrDrained || !lineageClosed) {
        break;
      }
      const remainingMs = cleanupDeadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      // This census only schedules retirement or escalation; it cannot certify closure.
      // The outside-group host must observe kernel group disappearance after we exit.
      if (hasLiveOwnedProcessGroupMembers(remainingMs) === false) {
        await closeAuthority(reason, false);
        return;
      }
      const nextObservationMs = Math.min(100, cleanupDeadline - Date.now());
      if (nextObservationMs <= 0) {
        break;
      }
      await Promise.race([delay(nextObservationMs), forceCleanupRequested.promise]);
    }
    await closeAuthority(reason, true);
  };

  const onControlMessage = (message: ServiceChildControlMessage) => {
    if (
      !start ||
      message.generation !== start.generation ||
      message.sequence <= lastHostSequence ||
      state === "closed"
    ) {
      return;
    }
    lastHostSequence = message.sequence;
    if (message.type === "startup-error-ack") {
      startupErrorAcknowledged.resolve();
      return;
    }
    void requestCleanup("cancel", message.signal);
  };

  const startCommand = async (next: ServiceChildStart) => {
    if (next.controlFd === undefined) {
      process.exitCode = 1;
      return;
    }
    start = next;
    let controlInput: Readable;
    if (process.versions.bun) {
      // Bun cannot wrap a duplex inherited fd in Socket. The anchor process owns
      // this shared descriptor until exit; neither stream may close the other direction.
      controlInput = createReadStream("", { fd: start.controlFd, autoClose: false });
      control = createWriteStream("", { fd: start.controlFd, autoClose: false });
    } else {
      // Node must use nonblocking socket IO: a pending fs read prevents process exit.
      const socket = new Socket({ fd: start.controlFd, readable: true, writable: true });
      controlInput = socket;
      control = socket;
    }
    controlInput.setEncoding("utf8");
    let pending = "";
    controlInput.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          // SAFETY: the private host control channel only writes encoded control messages.
          onControlMessage(JSON.parse(line) as ServiceChildControlMessage);
        } catch {
          void requestCleanup("parent-lost");
        }
      }
    });
    const onControlLoss = () => {
      if (state !== "closed") {
        void requestCleanup("parent-lost");
      }
    };
    controlInput.once("end", onControlLoss);
    controlInput.once("close", onControlLoss);
    controlInput.once("error", onControlLoss);
    if (controlInput !== control) {
      control.once("error", onControlLoss);
    }

    const { stdio, lineageFd } = commandStdio(start);
    try {
      command = spawn(start.command, start.args, {
        cwd: start.cwd,
        env: start.env,
        argv0: start.argv0,
        stdio,
        detached: false,
        windowsHide: true,
      });
      // Failed Bun spawns have no stdio. Preserve the spawn error before checking lineage.
      await once(command, "spawn");
    } catch (error) {
      await reportStartupFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    // SAFETY: lineageFd was reserved as a pipe in this exact command stdio array.
    const lineage = command.stdio[lineageFd] as Readable | null;
    if (!lineage) {
      await send({ type: "startup-error", error: "command lineage pipe was not created" });
      await requestCleanup("lineage-lost", "SIGKILL");
      return;
    }
    const markLineageClosed = () => {
      if (lineageClosed) {
        return;
      }
      lineageClosed = true;
      lineageDone.resolve();
      if (state === "active") {
        // Pipe EOF and the child exit notification race independently. Wait
        // briefly for the exact child event before treating EOF as lease loss.
        void (async () => {
          if (!rootExit) {
            await Promise.race([rootExited.promise, delay(LINEAGE_EXIT_OBSERVATION_MS)]);
          }
          if (state !== "active") {
            return;
          }
          if (rootExit && rootSettlementStarted) {
            await rootSettledDone.promise;
          }
          if (state !== "active") {
            return;
          }
          // Root settlement can only complete after output EOF. If lineage is gone
          // while output remains owned by a descendant, cleanup must reclaim the group.
          void requestCleanup("lineage-lost");
        })();
      }
    };
    lineage.once("end", markLineageClosed);
    lineage.once("close", markLineageClosed);
    lineage.once("error", markLineageClosed);
    const settleRoot = async () => {
      if (rootSettlementStarted || !rootResultDelivery || !stdoutDrained || !stderrDrained) {
        return;
      }
      rootSettlementStarted = true;
      await rootResultDelivery;
      rootSettledDone.resolve();
      if (lineageClosed && state === "active") {
        await requestCleanup("lineage-lost");
      }
    };
    // Bun's global streams retain output writers after pipeline completion. Node's
    // stdio streams must preserve fd 1/2: closing them aborts its later Linux spawnSync census.
    const stdout = process.versions.bun
      ? createWriteStream("", { fd: 1, autoClose: true })
      : process.stdout;
    const stderr = process.versions.bun
      ? createWriteStream("", { fd: 2, autoClose: true })
      : process.stderr;
    pipeline(command.stdout!, stdout, () => {
      stdoutDrained = true;
      void settleRoot();
    });
    pipeline(command.stderr!, stderr, () => {
      stderrDrained = true;
      void settleRoot();
    });
    if (start.stdinMode !== "inherit" && command.stdin) {
      const input = process.stdin;
      const destination = command.stdin;
      const endInput = () => destination.end();
      // Own EOF explicitly: pipe's default end check initializes global Bun output writers.
      input.pipe(destination, { end: false });
      destination.once("close", () => input.off("end", endInput));
      if (input.readableEnded) {
        endInput();
      } else {
        input.once("end", endInput);
      }
    }
    command.once("error", (error) => {
      if (state === "starting") {
        void reportStartupFailure(error.message);
      }
    });
    if (command.pid && state === "starting") {
      state = "active";
      void send({
        type: "ready",
        commandPid: command.pid,
        anchorPid: process.pid,
      });
    }
    command.once("exit", (code, signal) => {
      rootExit = { code, signal };
      // The host gates public settlement on output EOF, so record the authentic root
      // result before cleanup can hard-close an output-holding descendant.
      rootResultDelivery = send({ type: "root-result", code, signal });
      rootExited.resolve();
      void settleRoot();
    });
  };

  process.on("SIGTERM", () => {
    if (state === "active") {
      void requestCleanup("parent-lost");
    }
  });
  process.on("SIGINT", () => {
    if (state === "active") {
      void requestCleanup("parent-lost");
    }
  });
  process.once("disconnect", () => {
    if (state !== "closed") {
      void requestCleanup("parent-lost");
    }
  });
  process.on("message", (raw: unknown) => {
    // SAFETY: the spawned relay is the sole sender on this private IPC channel.
    const message = raw as ServiceChildStart | { type: "parent-loss"; generation?: string };
    if (message.type === "start" && state === "starting") {
      void startCommand(message);
    } else if (message.type === "parent-loss" && message.generation === start?.generation) {
      void requestCleanup("parent-lost");
    }
  });
}

runServiceChildGroupAnchor();
