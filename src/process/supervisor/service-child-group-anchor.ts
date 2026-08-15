import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "generation" | "sequence"> : never;
type ServiceChildAnchorPayload = WithoutEnvelope<ServiceChildAnchorMessage>;

const TERM_GRACE_MS = 1_000;
const LINEAGE_EXIT_OBSERVATION_MS = 100;

type AnchorState = "starting" | "active" | "closing" | "closed";
type StdioEntry = "ignore" | "inherit" | "pipe" | number;
type ServiceChildControlMessage = {
  generation: string;
  sequence: number;
} & ({ type: "cancel"; signal: "SIGTERM" | "SIGKILL" } | { type: "startup-error-ack" });
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
  let control: Socket | undefined;
  let rootSettlementStarted = false;
  let rootResultDelivery: Promise<void> | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let stdoutDrained = false;
  let stderrDrained = false;
  let lineageClosed = false;
  let forceCleanup = false;
  let resolveForceCleanup: () => void = () => {};
  const forceCleanupRequested = new Promise<void>((resolve) => {
    resolveForceCleanup = resolve;
  });
  let resolveLineage!: () => void;
  const lineageDone = new Promise<void>((resolve) => {
    resolveLineage = resolve;
  });
  let resolveRootExited!: () => void;
  const rootExited = new Promise<void>((resolve) => {
    resolveRootExited = resolve;
  });
  let resolveRootSettled!: () => void;
  const rootSettledDone = new Promise<void>((resolve) => {
    resolveRootSettled = resolve;
  });
  let resolveStartupErrorAck!: () => void;
  const startupErrorAcknowledged = new Promise<void>((resolve) => {
    resolveStartupErrorAck = resolve;
  });

  const send = async (message: ServiceChildAnchorPayload) => {
    if (!start || !control || control.destroyed) {
      return;
    }
    sequence += 1;
    await new Promise<void>((resolve) => {
      control!.write(
        encodeServiceChildMessage({
          ...message,
          generation: start!.generation,
          sequence,
        } as ServiceChildAnchorMessage),
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
    await send({ type: "closing", reason });
    if (hardKill) {
      // The live anchor is the sole authority: PID/PGID never leave this process as a kill target.
      process.kill(0, "SIGKILL");
      return;
    }
    control?.end(() => process.exit(0));
  };

  const reportStartupFailure = async (error: string) => {
    await send({ type: "startup-error", error });
    // A write callback only proves kernel acceptance. Keep the exact anchor alive until the
    // host records the authoritative spawn failure and acknowledges it on this same channel.
    await startupErrorAcknowledged;
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
        resolveForceCleanup();
      }
      return;
    }
    state = "closing";
    forceCleanup = signal === "SIGKILL";
    const termGraceDone = delay(TERM_GRACE_MS);
    if (!forceCleanup) {
      // The anchor catches its own signal while every command-group member receives it.
      process.kill(0, "SIGTERM");
      await Promise.race([lineageDone, termGraceDone, forceCleanupRequested]);
    }
    if (state !== "closing" || !start) {
      return;
    }
    if (lineageClosed && !rootExit && !forceCleanup) {
      // Cleanup already owns the group. A normal root exit may race lineage EOF,
      // but the short observation window must not replace the configured TERM grace.
      await Promise.race([rootExited, termGraceDone, forceCleanupRequested]);
    }
    if (state !== "closing" || !start) {
      return;
    }
    if (lineageClosed && rootExit && !forceCleanup) {
      // Output can outlive lineage and the root. It may preserve the authentic root
      // result only within the existing TERM grace, and KILL must wake this wait.
      await Promise.race([rootSettledDone, termGraceDone, forceCleanupRequested]);
      if (state !== "closing" || !start) {
        return;
      }
    }
    // Lineage EOF records descriptor closure, not group extinction. Once cleanup owns the
    // group, only the live in-group anchor may finish it after the TERM grace boundary.
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
      resolveStartupErrorAck();
      return;
    }
    void requestCleanup("cancel", message.signal);
  };

  const startCommand = async (next: ServiceChildStart) => {
    start = next;
    control = new Socket({ fd: start.controlFd, readable: true, writable: true });
    control.setEncoding("utf8");
    let pending = "";
    control.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          onControlMessage(JSON.parse(line) as ServiceChildControlMessage);
        } catch {
          void requestCleanup("parent-lost");
        }
      }
    });
    control.once("close", () => {
      if (state !== "closed") {
        void requestCleanup("parent-lost");
      }
    });
    control.once("error", () => {
      if (state !== "closed") {
        void requestCleanup("parent-lost");
      }
    });

    const { stdio, lineageFd } = commandStdio(start);
    try {
      command = spawn(start.command, start.args, {
        cwd: start.cwd,
        env: start.env,
        stdio,
        detached: false,
        windowsHide: true,
      });
    } catch (error) {
      await reportStartupFailure(error instanceof Error ? error.message : String(error));
      return;
    }
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
      resolveLineage();
      if (state === "active") {
        // Pipe EOF and the child exit notification race independently. Wait
        // briefly for the exact child event before treating EOF as lease loss.
        void (async () => {
          if (!rootExit) {
            await Promise.race([rootExited, delay(LINEAGE_EXIT_OBSERVATION_MS)]);
          }
          if (state !== "active") {
            return;
          }
          if (rootExit && rootSettlementStarted) {
            await rootSettledDone;
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
      resolveRootSettled();
      if (lineageClosed && state === "active") {
        await closeAuthority("lineage-closed", false);
      }
    };
    // Output EOF is independent of lineage EOF. Pipeline closes each forwarded stream
    // after its final write while the control channel retains descendant authority.
    pipeline(command.stdout!, process.stdout, () => {
      stdoutDrained = true;
      void settleRoot();
    });
    pipeline(command.stderr!, process.stderr, () => {
      stderrDrained = true;
      void settleRoot();
    });
    if (start.stdinMode !== "inherit" && command.stdin) {
      process.stdin.pipe(command.stdin);
      if (start.stdinMode === "pipe-closed" && process.stdin.readableEnded) {
        command.stdin.end();
      }
    }
    command.once("error", (error) => {
      if (state === "starting") {
        void reportStartupFailure(error.message);
      }
    });
    command.once("spawn", () => {
      if (!command?.pid || state !== "starting") {
        return;
      }
      state = "active";
      void send({
        type: "ready",
        commandPid: command.pid,
        anchorPid: process.pid,
      });
    });
    command.once("exit", (code, signal) => {
      rootExit = { code, signal };
      // The host gates public settlement on output EOF, so record the authentic root
      // result before cleanup can hard-close an output-holding descendant.
      rootResultDelivery = send({ type: "root-result", code, signal });
      resolveRootExited();
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
    const message = raw as ServiceChildStart | { type: "parent-loss"; generation?: string };
    if (message.type === "start" && state === "starting") {
      void startCommand(message);
    } else if (message.type === "parent-loss" && message.generation === start?.generation) {
      void requestCleanup("parent-lost");
    }
  });
}

runServiceChildGroupAnchor();
