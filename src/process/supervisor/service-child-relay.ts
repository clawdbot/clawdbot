import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { ServiceChildRelayMessage, ServiceChildStart } from "./service-child-protocol.js";

function runtimeArgv(url: URL): string[] {
  return url.pathname.endsWith(".ts")
    ? ["--import", "tsx", fileURLToPath(url)]
    : [fileURLToPath(url)];
}

type StdioEntry = "ignore" | "inherit" | "ipc" | number;

function reserveIpcFd(stdio: StdioEntry[]): void {
  let fd = 3;
  while (stdio[fd] !== undefined && stdio[fd] !== "ignore") {
    fd += 1;
  }
  while (stdio.length <= fd) {
    stdio.push("ignore");
  }
  stdio[fd] = "ipc";
}

export function runServiceChildRelay(): void {
  let generation: string | undefined;
  let anchor: ChildProcess | undefined;
  let parentLost = false;

  const report = (message: ServiceChildRelayMessage) => {
    if (!process.connected) {
      return;
    }
    try {
      process.send?.(message);
    } catch {
      // Direct host/anchor channel closure remains the fail-closed authority path.
    }
  };
  const notifyParentLoss = () => {
    if (parentLost) {
      return;
    }
    parentLost = true;
    if (anchor?.connected) {
      anchor.send({ type: "parent-loss", generation });
    }
  };

  process.once("disconnect", notifyParentLoss);
  process.once("SIGTERM", notifyParentLoss);
  process.once("SIGINT", notifyParentLoss);
  process.once("message", (raw: unknown) => {
    const start = raw as ServiceChildStart;
    if (!start || start.type !== "start" || !start.generation) {
      process.exitCode = 1;
      return;
    }
    generation = start.generation;
    const anchorUrl = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "service-child-group-anchor",
      distWorkerPath: "process/supervisor/service-child-group-anchor.js",
    });
    const stdio: StdioEntry[] = ["inherit", "inherit", "inherit"];
    while (stdio.length <= start.controlFd) {
      stdio.push("ignore");
    }
    stdio[start.controlFd] = start.controlFd;
    if (start.secretFd !== undefined) {
      while (stdio.length <= start.secretFd) {
        stdio.push("ignore");
      }
      stdio[start.secretFd] = start.secretFd;
    }
    reserveIpcFd(stdio);
    try {
      anchor = spawn(process.execPath, runtimeArgv(anchorUrl), {
        stdio,
        detached: true,
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      report({
        type: "relay-error",
        generation,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
      return;
    }
    if (!anchor.connected) {
      report({ type: "relay-error", generation, error: "anchor lifecycle IPC was not created" });
      anchor.kill("SIGKILL");
      process.exitCode = 1;
      return;
    }
    anchor.once("spawn", () => {
      anchor?.send(start);
      if (parentLost) {
        anchor?.send({ type: "parent-loss", generation });
      }
    });
    anchor.once("error", (error) => {
      report({ type: "relay-error", generation: generation!, error: error.message });
    });
    anchor.once("exit", (code, signal) => {
      report({ type: "anchor-exit", generation: generation!, code, signal });
      process.exit(code === 0 || signal === "SIGKILL" ? 0 : 1);
    });
  });
}

runServiceChildRelay();
