import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_GATEWAY_PORT } from "../../../config/paths.js";
import {
  RETURN_COVENANT_FIXTURE_COMMAND_RELATIVE_PATH,
  type ReturnCovenantPlan,
} from "./protocol.js";

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

type GatewayCommandIdentity = {
  device: number;
  inode: number;
  size: number;
};

function sha256(value: string | Uint8Array): string {
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
  readonly #gatewayEnvironment: NodeJS.ProcessEnv;
  readonly #gatewayExpectedSha256: string;
  readonly #gatewayPath: string;
  readonly #gateways: ManagedGateway[] = [];
  readonly #port: number;
  #current: ManagedGateway | undefined;

  constructor(params: {
    cwd: string;
    isolation: {
      configPath: string;
      homePath: string;
      statePath: string;
    };
    launchAuthority: {
      environment: NodeJS.ProcessEnv;
    };
    plan: ReturnCovenantPlan;
    runtimeConfig: { gateway?: { port?: number } };
  }) {
    this.#cwd = params.cwd;
    this.#gatewayPath = path.resolve(params.cwd, RETURN_COVENANT_FIXTURE_COMMAND_RELATIVE_PATH);
    this.#gatewayArgs = params.plan.driver.gatewayCommand.args;
    this.#gatewayExpectedSha256 = params.plan.driver.gatewayCommand.sha256;
    this.#gatewayEnvironment = {
      ...params.launchAuthority.environment,
      HOME: params.isolation.homePath,
      OPENCLAW_CONFIG_PATH: params.isolation.configPath,
      OPENCLAW_STATE_DIR: params.isolation.statePath,
    };
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
    // Hold the verified inode through spawn and recheck its pathname before
    // releasing it, so command substitution around the spawn fails closed.
    const verified = await this.#openVerifiedGatewayCommand();
    const port = this.#port + this.#gateways.length;
    if (port > 65_535) {
      await verified.handle.close();
      throw new Error("return-covenant gateway replacement port exceeds TCP range");
    }
    let managed: ManagedGateway | undefined;
    try {
      const child = spawn(process.execPath, [this.#gatewayPath, ...this.#gatewayArgs], {
        cwd: this.#cwd,
        env: {
          ...this.#gatewayEnvironment,
          OPENCLAW_GATEWAY_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) {
        throw new Error(`gateway ${label} did not receive a process id`);
      }
      const activeGateway: ManagedGateway = {
        child,
        endpoint: `http://127.0.0.1:${port}`,
        label,
        pid: child.pid,
        startFingerprint: "",
        stderr: "",
        stdout: "",
      };
      managed = activeGateway;
      const append = (field: "stderr" | "stdout", chunk: Buffer | string) => {
        activeGateway[field] = `${activeGateway[field]}${chunk.toString()}`.slice(-1_000_000);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      this.#gateways.push(activeGateway);
      await this.#assertGatewayCommandIdentity(verified.identity);
      activeGateway.startFingerprint = await processStartFingerprint(activeGateway.pid);
      await waitForGatewayReady(activeGateway, port);
      return activeGateway;
    } catch (error) {
      if (managed) {
        await stopGateway(managed).catch(() => undefined);
      }
      throw error;
    } finally {
      await verified.handle.close();
    }
  }

  async #openVerifiedGatewayCommand(): Promise<{
    handle: FileHandle;
    identity: GatewayCommandIdentity;
  }> {
    const handle = await open(this.#gatewayPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const command = await handle.stat();
      if (!command.isFile()) {
        throw new Error("planned return-covenant gateway command is not a regular file");
      }
      if (sha256(await handle.readFile()) !== this.#gatewayExpectedSha256) {
        throw new Error("planned return-covenant gateway command digest does not match");
      }
      const identity = {
        device: command.dev,
        inode: command.ino,
        size: command.size,
      };
      await this.#assertGatewayCommandIdentity(identity);
      return { handle, identity };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #assertGatewayCommandIdentity(expected: GatewayCommandIdentity): Promise<void> {
    const command = await lstat(this.#gatewayPath);
    if (
      !command.isFile() ||
      command.isSymbolicLink() ||
      command.dev !== expected.device ||
      command.ino !== expected.inode ||
      command.size !== expected.size
    ) {
      throw new Error("planned return-covenant gateway command identity changed");
    }
  }
}
