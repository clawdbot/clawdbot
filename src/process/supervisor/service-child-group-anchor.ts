import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildAnchorPayload,
  type ServiceChildStart,
} from "./service-child-protocol.js";

const TERM_GRACE_MS = 1_000;

type AnchorState = "starting" | "active" | "closing" | "closed";
type StdioEntry = "ignore" | "inherit" | "pipe" | number;
type ServiceChildHostMessage =
  | ServiceChildStart
  | {
      type: "cancel";
      generation: string;
      sequence: number;
      signal: "SIGTERM" | "SIGKILL";
    };

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
  let rootSettled = false;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let stdoutDrained = false;
  let stderrDrained = false;
  let lineageClosed = false;
  let cleanupClaim: symbol | undefined;
  let forceCleanup = false;
  let resolveLineage!: () => void;
  const lineageDone = new Promise<void>((resolve) => {
    resolveLineage = resolve;
  });

  const send = async (message: ServiceChildAnchorPayload) => {
    if (!start || !control || control.destroyed) {
      return;
    }
    sequence += 1;
    await new Promise<void>((resolve, reject) => {
      control!.write(
        encodeServiceChildMessage({
          ...message,
          generation: start!.generation,
          sequence,
        } as ServiceChildAnchorMessage),
        (error) => (error ? reject(error) : resolve()),
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

  const requestCleanup = async (
    reason: "cancel" | "lineage-lost" | "parent-lost",
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ) => {
    if (!start || state === "closed") {
      return;
    }
    if (state === "closing") {
      forceCleanup ||= signal === "SIGKILL";
      return;
    }
    state = "closing";
    const claim = Symbol("service-child-cleanup");
    cleanupClaim = claim;
    forceCleanup = signal === "SIGKILL";
    if (!forceCleanup) {
      // The anchor catches its own signal while every command-group member receives it.
      process.kill(0, "SIGTERM");
      await Promise.race([lineageDone, delay(TERM_GRACE_MS)]);
    }
    if (state !== "closing" || cleanupClaim !== claim || !start) {
      return;
    }
    if (lineageClosed && rootExit && !forceCleanup) {
      await closeAuthority(reason, false);
      return;
    }
    await closeAuthority(reason, true);
  };

  const onControlMessage = (message: ServiceChildHostMessage) => {
    if (
      !start ||
      message.type !== "cancel" ||
      message.generation !== start.generation ||
      message.sequence <= lastHostSequence ||
      state === "closed"
    ) {
      return;
    }
    lastHostSequence = message.sequence;
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
          onControlMessage(JSON.parse(line) as ServiceChildHostMessage);
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
      await send({
        type: "startup-error",
        error: error instanceof Error ? error.message : String(error),
      });
      await closeAuthority("lineage-lost", false);
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
        // Pipe EOF and root exit can be delivered in either event-loop order.
        // Give the authentic root result one turn before classifying EOF as an early lease loss.
        setImmediate(() => {
          if (state !== "active") {
            return;
          }
          if (rootSettled) {
            void closeAuthority("lineage-closed", false);
          } else if (!rootExit) {
            void requestCleanup("lineage-lost");
          }
        });
      }
    };
    lineage.once("end", markLineageClosed);
    lineage.once("close", markLineageClosed);
    lineage.once("error", markLineageClosed);
    command.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    command.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    command.stdout?.on("error", () => {});
    command.stderr?.on("error", () => {});
    const settleRoot = async () => {
      if (rootSettled || !rootExit || !stdoutDrained || !stderrDrained) {
        return;
      }
      rootSettled = true;
      await send({ type: "root-result", code: rootExit.code, signal: rootExit.signal });
      if (lineageClosed && state === "active") {
        await closeAuthority("lineage-closed", false);
      }
    };
    const markStdoutDrained = () => {
      stdoutDrained = true;
      void settleRoot();
    };
    const markStderrDrained = () => {
      stderrDrained = true;
      void settleRoot();
    };
    command.stdout?.once("end", markStdoutDrained);
    command.stdout?.once("close", markStdoutDrained);
    command.stderr?.once("end", markStderrDrained);
    command.stderr?.once("close", markStderrDrained);
    if (start.stdinMode !== "inherit" && command.stdin) {
      process.stdin.pipe(command.stdin);
      if (start.stdinMode === "pipe-closed" && process.stdin.readableEnded) {
        command.stdin.end();
      }
    }
    command.once("error", async (error) => {
      if (state === "starting") {
        await send({ type: "startup-error", error: error.message });
        await closeAuthority("lineage-lost", false);
      }
    });
    command.once("spawn", async () => {
      if (!command?.pid || state !== "starting") {
        return;
      }
      state = "active";
      await send({
        type: "ready",
        commandPid: command.pid,
        anchorPid: process.pid,
      });
    });
    command.once("exit", (code, signal) => {
      rootExit = { code, signal };
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
