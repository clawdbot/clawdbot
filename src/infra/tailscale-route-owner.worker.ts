// Owns one foreground Tailscale route claim and releases it when Gateway IPC closes.
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { signalProcessTree } from "../process/kill-tree.js";
import {
  TAILSCALE_ROUTE_OWNER_ARG,
  type TailscaleRouteOwnerMessage,
} from "./tailscale-route-owner-protocol.js";

// Tailscale prints this only after SetServeConfig succeeds and its foreground
// WatchIPNBus session owns the route. Treat earlier process startup as unclaimed.
const READY_MARKER = "Press Ctrl+C to exit.";
const OUTPUT_LIMIT = 200_000;
const STOP_GRACE_MS = 2_000;

type RouteOwnerStart = { argv: string[] };

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}

function parseStart(raw: string | undefined): RouteOwnerStart {
  const parsed: unknown = JSON.parse(raw ?? "null");
  const argv = isRecord(parsed) ? parsed.argv : undefined;
  if (
    !Array.isArray(argv) ||
    !argv.every((entry) => typeof entry === "string") ||
    argv.length === 0
  ) {
    throw new Error("invalid Tailscale route-owner start payload");
  }
  return { argv };
}

function send(message: TailscaleRouteOwnerMessage): void {
  if (!process.connected || !process.send) {
    return;
  }
  try {
    process.send(message, () => undefined);
  } catch {
    // The parent can disappear between the connected check and send.
  }
}

export type TailscaleRouteOwnerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopping: boolean;
};

export type TailscaleRouteOwnerHandle = {
  exited: Promise<TailscaleRouteOwnerExit>;
  stop: () => void;
};

function signalChild(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (typeof child.pid !== "number" || child.pid <= 0) {
    return;
  }
  if (process.platform !== "win32") {
    signalProcessTree(child.pid, signal, { detached: true });
    return;
  }
  child.kill(signal === "SIGKILL" ? "SIGTERM" : signal);
}

export function runTailscaleRouteOwner(
  start: RouteOwnerStart,
  sendMessage: (message: TailscaleRouteOwnerMessage) => void = send,
): TailscaleRouteOwnerHandle {
  const command = start.argv[0];
  if (!command) {
    throw new Error("Tailscale route-owner command is empty");
  }
  const args = start.argv.slice(1);
  let stdout = "";
  let stderr = "";
  let ready = false;
  let stopping = false;
  let forceTimer: NodeJS.Timeout | undefined;
  let resolveExit!: (exit: TailscaleRouteOwnerExit) => void;
  const exited = new Promise<TailscaleRouteOwnerExit>((resolve) => {
    resolveExit = resolve;
  });
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    signalChild(child, "SIGTERM");
    forceTimer = setTimeout(() => signalChild(child, "SIGKILL"), STOP_GRACE_MS);
    forceTimer.unref?.();
  };
  child.once("spawn", () => {
    if (typeof child.pid === "number") {
      sendMessage({ type: "spawned", pid: child.pid });
    }
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
    if (!ready && stdout.includes(READY_MARKER)) {
      ready = true;
      sendMessage({ type: "ready" });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
    if (!ready && stderr.includes(READY_MARKER)) {
      ready = true;
      sendMessage({ type: "ready" });
    }
  });
  child.once("error", (error) => {
    stderr = appendBounded(stderr, error instanceof Error ? error.message : String(error));
  });
  child.once("close", (code, signal) => {
    if (forceTimer) {
      clearTimeout(forceTimer);
    }
    if (!stopping || !ready) {
      sendMessage({ type: "failed", code, signal, stdout, stderr });
    }
    resolveExit({ code, signal, stopping });
  });
  return { exited, stop };
}

if (process.argv[2] === TAILSCALE_ROUTE_OWNER_ARG) {
  try {
    const owner = runTailscaleRouteOwner(parseStart(process.argv[3]));
    // Terminal signals reach this worker with the Gateway process group. Drain the
    // detached route child first or the HTTPS port remains claimed after Gateway exit.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, owner.stop);
    }
    process.once("disconnect", owner.stop);
    process.once("message", (message: unknown) => {
      if (isRecord(message) && message.type === "stop") {
        owner.stop();
      }
    });
    void owner.exited.then((exit) => process.exit(exit.stopping ? 0 : 1));
  } catch (error) {
    send({
      type: "failed",
      code: null,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
