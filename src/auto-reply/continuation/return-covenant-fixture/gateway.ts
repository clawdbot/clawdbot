import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import { ADMIN_SCOPE } from "../../../gateway/method-scopes.js";
import {
  assertReturnCovenantGatewayBinding,
  parseReturnCovenantGatewayBinding,
  type ReturnCovenantGatewayBinding,
  type ReturnCovenantGatewayRestart,
} from "./gateway-generation.js";
import { waitForReturnCovenantGatewayReady } from "./gateway-readiness.js";
import { RETURN_COVENANT_GATEWAY_METHOD } from "./gateway-rpc.js";
import {
  RETURN_COVENANT_FIXTURE_COMMAND_RELATIVE_PATH,
  type ReturnCovenantDriverAttestation,
  type ReturnCovenantPhaseRequest,
  type ReturnCovenantPlan,
} from "./protocol.js";
import {
  parseReturnCovenantRunSnapshot,
  type ReturnCovenantFixtureRunSnapshot,
} from "./run-snapshot.js";

export type { ReturnCovenantGatewayBinding, ReturnCovenantGatewayRestart };

export type ReturnCovenantGatewayPhaseResult = {
  finalizeRequested: boolean;
  payload: Record<string, unknown>;
};

interface ReturnCovenantGatewayControl {
  current(): ReturnCovenantGatewayBinding;
  finalizeRun(): Promise<Record<string, unknown>>;
  invokePhase(
    request: ReturnCovenantPhaseRequest,
    attestation: ReturnCovenantDriverAttestation,
  ): Promise<ReturnCovenantGatewayPhaseResult>;
  start(): Promise<ReturnCovenantGatewayBinding>;
  stopAll(): Promise<void>;
}

type ManagedGateway = {
  binding: ReturnCovenantGatewayBinding;
  child: ChildProcess;
  label: string;
  stderr: string;
  stdout: string;
};

type StartingGateway = Omit<ManagedGateway, "binding"> & {
  pid: number;
};

type GatewayCommandIdentity = {
  device: number;
  inode: number;
  size: number;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
  readonly #config: OpenClawConfig;
  readonly #configPath: string;
  readonly #cwd: string;
  readonly #gatewayArgs: readonly string[];
  readonly #gatewayEnvironment: NodeJS.ProcessEnv;
  readonly #gatewayExpectedSha256: string;
  readonly #gatewayPath: string;
  readonly #gatewayToken: string;
  readonly #gateways: ManagedGateway[] = [];
  readonly #plan: ReturnCovenantPlan;
  readonly #port: number;
  #current: ManagedGateway | undefined;

  constructor(params: {
    configPath: string;
    cwd: string;
    gatewayToken: string;
    isolation: {
      homePath: string;
      statePath: string;
    };
    launchAuthority: {
      environment: NodeJS.ProcessEnv;
    };
    plan: ReturnCovenantPlan;
    runtimeConfig: OpenClawConfig;
  }) {
    this.#config = params.runtimeConfig;
    this.#configPath = params.configPath;
    this.#cwd = params.cwd;
    this.#gatewayPath = path.resolve(params.cwd, RETURN_COVENANT_FIXTURE_COMMAND_RELATIVE_PATH);
    this.#gatewayArgs = params.plan.driver.gatewayCommand.args;
    this.#gatewayExpectedSha256 = params.plan.driver.gatewayCommand.sha256;
    this.#gatewayToken = params.gatewayToken;
    this.#gatewayEnvironment = {
      ...params.launchAuthority.environment,
      HOME: params.isolation.homePath,
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_STATE_DIR: params.isolation.statePath,
    };
    this.#plan = params.plan;
    this.#port = params.runtimeConfig.gateway?.port ?? 18_789;
  }

  current(): ReturnCovenantGatewayBinding {
    if (!this.#current) {
      throw new Error("return-covenant gateway is not running");
    }
    return this.#current.binding;
  }

  async start(): Promise<ReturnCovenantGatewayBinding> {
    if (this.#current) {
      throw new Error("return-covenant gateway already started");
    }
    this.#current = await this.#spawnGateway("initial");
    return this.current();
  }

  async invokePhase(
    request: ReturnCovenantPhaseRequest,
    attestation: ReturnCovenantDriverAttestation,
  ): Promise<ReturnCovenantGatewayPhaseResult> {
    let restart: ReturnCovenantGatewayRestart | undefined;
    if (request.phase === "transition" && request.restartBetweenAcceptanceAndRelease) {
      restart = await this.#restartForTransition();
    }
    const response = await this.#request(this.#requireCurrent(), {
      operation: "phase",
      phaseRequest: request,
      attestation,
      ...(restart ? { restart } : {}),
    });
    if (!isRecord(response.payload)) {
      throw new Error("return-covenant gateway phase returned no payload");
    }
    return {
      finalizeRequested: response.finalizeRequested === true,
      payload: response.payload,
    };
  }

  async finalizeRun(): Promise<Record<string, unknown>> {
    const response = await this.#request(this.#requireCurrent(), {
      operation: "finalize",
    });
    if (!isRecord(response.claims)) {
      throw new Error("return-covenant gateway finalization returned no cleanup claims");
    }
    return response.claims;
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

  #requireCurrent(): ManagedGateway {
    if (!this.#current) {
      throw new Error("return-covenant gateway is not running");
    }
    return this.#current;
  }

  async #restartForTransition(): Promise<ReturnCovenantGatewayRestart> {
    const original = this.#requireCurrent();
    const snapshotResponse = await this.#request(original, { operation: "snapshot" });
    if (snapshotResponse.snapshot === undefined) {
      throw new Error("return-covenant gateway restart returned no run snapshot");
    }
    const snapshot = parseReturnCovenantRunSnapshot(snapshotResponse.snapshot);
    await stopGateway(original);
    this.#current = undefined;
    const replacement = await this.#spawnGateway(`replacement-${this.#gateways.length}`, snapshot);
    this.#current = replacement;
    return {
      original: original.binding,
      replacement: replacement.binding,
    };
  }

  async #spawnGateway(
    label: string,
    snapshot?: ReturnCovenantFixtureRunSnapshot,
  ): Promise<ManagedGateway> {
    const verified = await this.#openVerifiedGatewayCommand();
    const port = this.#port + this.#gateways.length;
    if (port > 65_535) {
      await verified.handle.close();
      throw new Error("return-covenant gateway replacement port exceeds TCP range");
    }
    let starting: StartingGateway | undefined;
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
      starting = {
        child,
        label,
        pid: child.pid,
        stderr: "",
        stdout: "",
      };
      const output = starting;
      const append = (field: "stderr" | "stdout", chunk: Buffer | string) => {
        output[field] = `${output[field]}${chunk.toString()}`.slice(-1_000_000);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      await this.#assertGatewayCommandIdentity(verified.identity);
      const binding = await waitForReturnCovenantGatewayReady(starting, port);
      managed = {
        binding,
        child,
        label,
        stderr: starting.stderr,
        stdout: starting.stdout,
      };
      this.#gateways.push(managed);
      await this.#request(managed, {
        operation: "initialize",
        plan: this.#plan,
        ...(snapshot ? { snapshot } : {}),
      });
      return managed;
    } catch (error) {
      if (managed) {
        await stopGateway(managed).catch(() => undefined);
      } else if (starting) {
        await stopGateway({
          binding: {
            bootId: "starting",
            endpoint: `http://127.0.0.1:${port}`,
            pid: starting.pid,
            startFingerprint: "0".repeat(64),
          },
          child: starting.child,
          label: starting.label,
          stderr: starting.stderr,
          stdout: starting.stdout,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      await verified.handle.close();
    }
  }

  async #request(
    gateway: ManagedGateway,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
      throw new Error("return-covenant request targets a stopped gateway generation");
    }
    let helloBootId: string | undefined;
    const response = await callGateway({
      clientDisplayName: "return-covenant-fixture",
      config: this.#config,
      configPath: this.#configPath,
      deviceIdentity: null,
      ignoreEnvUrlOverride: true,
      method: RETURN_COVENANT_GATEWAY_METHOD,
      onHelloOk: (hello) => {
        helloBootId = hello.server.bootId;
      },
      params: {
        ...params,
        expectedGateway: gateway.binding,
      },
      requiredMethods: [RETURN_COVENANT_GATEWAY_METHOD],
      scopes: [ADMIN_SCOPE],
      sharedStateMode: "read-only",
      timeoutMs: 120_000,
      token: this.#gatewayToken,
      url: gateway.binding.endpoint.replace(/^http:/u, "ws:"),
      useStoredDeviceAuth: false,
    });
    if (helloBootId !== gateway.binding.bootId) {
      throw new Error("return-covenant gateway hello reported a stale boot generation");
    }
    const responseBinding = parseReturnCovenantGatewayBinding(response.gateway);
    assertReturnCovenantGatewayBinding(
      responseBinding,
      gateway.binding,
      "return-covenant gateway response came from a stale generation",
    );
    if (gateway !== this.#current && params.operation !== "initialize") {
      throw new Error("return-covenant gateway generation was replaced during request");
    }
    return response;
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
