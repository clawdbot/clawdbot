import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_GATEWAY_PORT } from "../../../config/paths.js";
import type { ReturnCovenantPlan } from "./protocol.js";

export type ReturnCovenantGatewayBinding = {
  endpoint: string;
  pid: number;
  startFingerprint: string;
};

export type ReturnCovenantGatewayRestart = {
  original: ReturnCovenantGatewayBinding;
  replacement: ReturnCovenantGatewayBinding;
};

export interface ReturnCovenantGatewayControl {
  current(): ReturnCovenantGatewayBinding;
  restart(): Promise<ReturnCovenantGatewayRestart>;
  start(): Promise<ReturnCovenantGatewayBinding>;
  stopAll(): Promise<void>;
}

type ManagedGateway = ReturnCovenantGatewayBinding & {
  child: ChildProcess;
  label: string;
  stderr: string;
  stdout: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function processStartFingerprint(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = raw
    .slice(raw.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  if (!startTicks) {
    throw new Error(`gateway ${pid} has no kernel start timestamp`);
  }
  return sha256(`${pid}:${startTicks}`);
}

async function probeLoopbackPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForGatewayReady(
  gateway: Pick<ManagedGateway, "child" | "label" | "pid" | "stderr">,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
      const reason =
        gateway.child.signalCode !== null
          ? `signal ${gateway.child.signalCode}`
          : `exit ${gateway.child.exitCode}`;
      throw new Error(
        `gateway ${gateway.label} stopped before readiness (${reason}): ${gateway.stderr.slice(-2000)}`,
      );
    }
    if (await probeLoopbackPort(port)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`gateway ${gateway.label} did not listen on loopback before the deadline`);
}

async function stopGateway(gateway: ManagedGateway): Promise<void> {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
    return;
  }
  let settled = false;
  const exited = once(gateway.child, "exit").then(() => {
    settled = true;
  });
  gateway.child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (!settled) {
    gateway.child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }
  if (!settled) {
    throw new Error(`gateway ${gateway.label} did not stop after SIGTERM and SIGKILL`);
  }
}

export class ProductReturnCovenantGatewayControl implements ReturnCovenantGatewayControl {
  readonly #cwd: string;
  readonly #gatewayArgs: readonly string[];
  readonly #gatewayPath: string;
  readonly #gateways: ManagedGateway[] = [];
  readonly #port: number;
  #current: ManagedGateway | undefined;

  constructor(params: {
    cwd: string;
    plan: ReturnCovenantPlan;
    runtimeConfig: { gateway?: { port?: number } };
  }) {
    this.#cwd = params.cwd;
    this.#gatewayPath = path.resolve(params.cwd, params.plan.driver.gatewayCommand.relativePath);
    this.#gatewayArgs = params.plan.driver.gatewayCommand.args;
    this.#port = params.runtimeConfig.gateway?.port ?? DEFAULT_GATEWAY_PORT;
  }

  current(): ReturnCovenantGatewayBinding {
    if (!this.#current) {
      throw new Error("return-covenant gateway is not running");
    }
    return {
      endpoint: this.#current.endpoint,
      pid: this.#current.pid,
      startFingerprint: this.#current.startFingerprint,
    };
  }

  async start(): Promise<ReturnCovenantGatewayBinding> {
    if (this.#current) {
      throw new Error("return-covenant gateway already started");
    }
    this.#current = await this.#spawnGateway("initial");
    return this.current();
  }

  async restart(): Promise<ReturnCovenantGatewayRestart> {
    const original = this.#current;
    if (!original) {
      throw new Error("cannot restart a return-covenant gateway before startup");
    }
    await stopGateway(original);
    this.#current = undefined;
    const replacement = await this.#spawnGateway(`replacement-${this.#gateways.length}`);
    this.#current = replacement;
    return {
      original: {
        endpoint: original.endpoint,
        pid: original.pid,
        startFingerprint: original.startFingerprint,
      },
      replacement: this.current(),
    };
  }

  async stopAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const gateway of this.#gateways.toReversed()) {
      try {
        await stopGateway(gateway);
      } catch (error) {
        failures.push(error);
      }
    }
    this.#current = undefined;
    if (failures.length > 0) {
      throw new AggregateError(failures, "return-covenant gateway cleanup failed");
    }
  }

  async #spawnGateway(label: string): Promise<ManagedGateway> {
    const command = await lstat(this.#gatewayPath);
    if (!command.isFile() || command.isSymbolicLink()) {
      throw new Error("planned return-covenant gateway command is not a regular file");
    }
    const child = spawn(process.execPath, [this.#gatewayPath, ...this.#gatewayArgs], {
      cwd: this.#cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) {
      throw new Error(`gateway ${label} did not receive a process id`);
    }
    const managed: ManagedGateway = {
      child,
      endpoint: `http://127.0.0.1:${this.#port}`,
      label,
      pid: child.pid,
      startFingerprint: "",
      stderr: "",
      stdout: "",
    };
    const append = (field: "stderr" | "stdout", chunk: Buffer | string) => {
      managed[field] = `${managed[field]}${chunk.toString()}`.slice(-1_000_000);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    this.#gateways.push(managed);
    try {
      managed.startFingerprint = await processStartFingerprint(managed.pid);
      await waitForGatewayReady(managed, this.#port);
      return managed;
    } catch (error) {
      await stopGateway(managed).catch(() => undefined);
      throw error;
    }
  }
}
