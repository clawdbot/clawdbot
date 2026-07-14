import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachChildProcessBridge } from "../process/child-process-bridge.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildCellCreateArgs,
  buildCellRunArgs,
  validateFleetImage,
  type CellContainerProfile,
  type FleetContainerRuntimeName,
} from "./cell-profile.js";
import { createRedactingStreamWriter } from "./containers.redaction.js";

type FleetContainerCommandOptions = {
  allowFailure?: boolean;
  redactValues?: readonly string[];
};

type FleetContainerCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type FleetContainerCommandExecutor = (
  runtime: FleetContainerRuntimeName,
  args: string[],
  options: FleetContainerCommandOptions,
) => Promise<FleetContainerCommandResult>;

type FleetContainerStreamResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

// Mirrors the termination set attachChildProcessBridge forwards, plus SIGPIPE for a
// downstream reader (e.g. `| head`) closing the inherited stdout mid-stream.
const DELIBERATE_STREAM_STOP_SIGNALS = new Set<NodeJS.Signals>([
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
  "SIGBREAK",
  "SIGPIPE",
]);

export type FleetContainerStreamExecutor = (
  runtime: FleetContainerRuntimeName,
  args: string[],
  options: { redactValues: readonly string[] },
) => Promise<FleetContainerStreamResult>;

type FleetContainerLogsOptions = {
  follow?: boolean;
  tail?: number;
  since?: string;
  redactValues: readonly string[];
};

export type FleetContainerInspectResult =
  | {
      kind: "ok";
      state: string;
      running: boolean;
      labels: Record<string, string>;
      environment: Record<string, string>;
      imageId: string;
      memory: string;
      cpus: string;
      pidsLimit: number | undefined;
      storageOpt: Record<string, string>;
      capDrop: string[];
      // Podman-only top-level inspect field: null means every capability is
      // dropped, a list means caps remain, and Docker omits the field entirely.
      effectiveCaps: string[] | undefined;
      securityOpt: string[];
      init: boolean | undefined;
      restartPolicy: string | undefined;
      portBindings: Array<{ containerPort: string; hostIp: string; hostPort: string }>;
      user?: string;
      usernsMode?: string;
    }
  | { kind: "missing"; state: "missing" }
  | { kind: "unavailable"; state: "unknown"; error: string };

export type FleetNetworkInspectResult =
  | {
      kind: "ok";
      labels: Record<string, string>;
      attachedContainers: Array<{ id: string; name?: string }>;
      internal: boolean;
    }
  | { kind: "missing" }
  | { kind: "unavailable"; error: string };

export type FleetContainerRuntime = ReturnType<typeof createFleetContainerRuntime>;

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

class InvalidInspectOutputError extends Error {
  constructor() {
    super("container inspect returned an invalid response");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function requireNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function readLabels(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  const record = requireRecord(value);
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(record)) {
    if (typeof label !== "string") {
      throw new InvalidInspectOutputError();
    }
    labels[key] = label;
  }
  return labels;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  const record = requireRecord(value);
  for (const entry of Object.values(record)) {
    if (typeof entry !== "string") {
      throw new InvalidInspectOutputError();
    }
  }
  return record as Record<string, string>;
}

function readStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireBoolean(value);
}

function readRestartPolicy(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readOptionalString(requireRecord(value).Name);
}

function readPortBindings(
  value: unknown,
): Array<{ containerPort: string; hostIp: string; hostPort: string }> {
  if (value === undefined || value === null) {
    return [];
  }
  const bindings: Array<{ containerPort: string; hostIp: string; hostPort: string }> = [];
  for (const [containerPort, rawEntries] of Object.entries(requireRecord(value))) {
    if (!containerPort || !Array.isArray(rawEntries)) {
      throw new InvalidInspectOutputError();
    }
    for (const rawEntry of rawEntries) {
      const entry = requireRecord(rawEntry);
      bindings.push({
        containerPort,
        hostIp: requireString(entry.HostIp),
        hostPort: requireString(entry.HostPort),
      });
    }
  }
  return bindings;
}

function readNetworkAttachments(value: unknown): Array<{ id: string; name?: string }> {
  if (value === undefined || value === null) {
    return [];
  }
  const record = requireRecord(value);
  return Object.entries(record)
    .map(([id, rawAttachment]) => {
      if (!id) {
        throw new InvalidInspectOutputError();
      }
      const attachment = requireRecord(rawAttachment);
      const name = readOptionalString(attachment.Name ?? attachment.name);
      const normalized: { id: string; name?: string } = { id };
      if (name) {
        normalized.name = name;
      }
      return normalized;
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function readEnvironment(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new InvalidInspectOutputError();
  }
  const environment: Record<string, string> = {};
  for (const assignment of value) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new InvalidInspectOutputError();
    }
    environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return environment;
}

function readPidsLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === 0) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidInspectOutputError();
  }
  return value;
}

function parseInspectOutput(stdout: string): Extract<FleetContainerInspectResult, { kind: "ok" }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new InvalidInspectOutputError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new InvalidInspectOutputError();
  }

  const inspected = requireRecord(parsed[0]);
  const state = requireRecord(inspected.State);
  const config = requireRecord(inspected.Config);
  const hostConfig = requireRecord(inspected.HostConfig);
  const nanoCpus = requireNonNegativeNumber(hostConfig.NanoCpus);
  const user = readOptionalString(config.User);
  const usernsMode = readOptionalString(hostConfig.UsernsMode);

  return {
    kind: "ok",
    state: requireString(state.Status),
    running: requireBoolean(state.Running),
    labels: readLabels(config.Labels),
    environment: readEnvironment(config.Env),
    imageId: requireString(inspected.Image),
    memory: String(requireNonNegativeNumber(hostConfig.Memory)),
    cpus: String(nanoCpus / 1_000_000_000),
    pidsLimit: readPidsLimit(hostConfig.PidsLimit),
    storageOpt: readStringRecord(hostConfig.StorageOpt),
    capDrop: readStringArray(hostConfig.CapDrop),
    effectiveCaps:
      inspected.EffectiveCaps === undefined ? undefined : readStringArray(inspected.EffectiveCaps),
    securityOpt: readStringArray(hostConfig.SecurityOpt),
    init: readOptionalBoolean(hostConfig.Init),
    restartPolicy: readRestartPolicy(hostConfig.RestartPolicy),
    portBindings: readPortBindings(hostConfig.PortBindings),
    ...(user ? { user } : {}),
    ...(usernsMode ? { usernsMode } : {}),
  };
}

function parseNetworkInspectOutput(
  stdout: string,
): Extract<FleetNetworkInspectResult, { kind: "ok" }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new InvalidInspectOutputError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new InvalidInspectOutputError();
  }

  const inspected = requireRecord(parsed[0]);
  return {
    kind: "ok",
    labels: readLabels(inspected.Labels ?? inspected.labels),
    attachedContainers: readNetworkAttachments(inspected.Containers ?? inspected.containers),
    internal: readOptionalBoolean(inspected.Internal ?? inspected.internal) ?? false,
  };
}

function parseDockerContextEndpoint(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("docker context inspect returned an invalid response");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("docker context inspect returned an invalid response");
  }
  try {
    const context = requireRecord(parsed[0]);
    const endpoints = requireRecord(context.Endpoints);
    const docker = requireRecord(endpoints.docker);
    return requireString(docker.Host);
  } catch {
    throw new Error("docker context inspect returned an invalid response");
  }
}

function isLocalDockerEndpoint(endpoint: string): boolean {
  const normalized = endpoint.toLowerCase();
  const unixPrefix = "unix:///";
  if (normalized.startsWith(unixPrefix)) {
    return normalized.length > unixPrefix.length;
  }
  const windowsPipePrefix = "npipe:////./pipe/";
  return (
    process.platform === "win32" &&
    normalized.startsWith(windowsPipePrefix) &&
    normalized.length > windowsPipePrefix.length
  );
}

function parsePodmanServiceIsRemote(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("podman info returned an invalid response");
  }
  try {
    const info = requireRecord(parsed);
    const host = requireRecord(info.host);
    const serviceIsRemote = host.serviceIsRemote;
    if (typeof serviceIsRemote !== "boolean") {
      throw new Error();
    }
    return serviceIsRemote;
  } catch {
    throw new Error("podman info returned an invalid response");
  }
}

function parseDockerRootlessInfo(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("docker info returned an invalid security-options response");
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("docker info returned an invalid security-options response");
  }
  return parsed.some((entry) => entry.split(",").includes("name=rootless"));
}

function readEnvironmentValues(args: readonly string[], extraValues?: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    let assignment: string | undefined;
    if (arg === "--env" || arg === "-e") {
      assignment = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--env=")) {
      assignment = arg.slice("--env=".length);
    } else if (arg.startsWith("-e=")) {
      assignment = arg.slice("-e=".length);
    }
    if (!assignment) {
      continue;
    }
    const separator = assignment.indexOf("=");
    if (separator >= 0 && separator < assignment.length - 1) {
      values.push(assignment.slice(separator + 1));
    }
  }
  for (const value of extraValues ?? []) {
    if (value) {
      values.push(value);
    }
  }
  return [...new Set(values)];
}

function redactEnvironmentValues(
  text: string,
  args: readonly string[],
  extraValues?: readonly string[],
): string {
  let redacted = text;
  const values = readEnvironmentValues(args, extraValues).toSorted(
    (left, right) => right.length - left.length,
  );
  for (const value of values) {
    redacted = redacted.replaceAll(value, "<redacted>");
  }
  return redacted;
}

function formatExecutorError(
  error: unknown,
  runtime: FleetContainerRuntimeName,
  args: readonly string[],
  extraValues?: readonly string[],
): Error {
  const detail =
    error instanceof Error ? redactEnvironmentValues(error.message, args, extraValues).trim() : "";
  return new Error(detail || `${runtime} container command failed`);
}

function commandFailureError(
  runtime: FleetContainerRuntimeName,
  args: readonly string[],
  result: FleetContainerCommandResult,
  extraValues?: readonly string[],
): Error {
  const detail = redactEnvironmentValues(result.stderr, args, extraValues).trim();
  return new Error(detail || `${runtime} container command failed with exit code ${result.code}`);
}

const defaultFleetContainerCommandExecutor: FleetContainerCommandExecutor = async (
  runtime,
  args,
  options,
) => {
  const result = await runCommandWithTimeout([runtime, ...args], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
  });
  const normalized = {
    stdout: result.stdout,
    stderr: redactEnvironmentValues(result.stderr, args, options.redactValues),
    code: result.code ?? 1,
  };
  if (normalized.code !== 0 && !options.allowFailure) {
    throw commandFailureError(runtime, args, normalized, options.redactValues);
  }
  return normalized;
};

const defaultFleetContainerStreamExecutor: FleetContainerStreamExecutor = (
  runtime,
  args,
  options,
) =>
  new Promise<FleetContainerStreamResult>((resolve, reject) => {
    // Pipe instead of inheriting stdio so the cell's Gateway token can be
    // redacted from live log content; argv itself carries no secrets.
    const child = spawn(runtime, args, { stdio: ["ignore", "pipe", "pipe"] });
    // Forward every termination signal (SIGINT/SIGTERM/SIGHUP/...), not just Ctrl-C:
    // a supervisor signaling only the CLI PID must never orphan a follow stream.
    // The bridge detaches itself on child exit.
    attachChildProcessBridge(child);
    const stdout = createRedactingStreamWriter(process.stdout, options.redactValues);
    const stderr = createRedactingStreamWriter(process.stderr, options.redactValues);
    // A downstream reader closing our stdout (e.g. `| head`) surfaces as a
    // stream error here rather than SIGPIPE on the child; end the child so a
    // follow stream terminates instead of writing into a broken pipe forever.
    const onTargetError = (): void => {
      child.kill("SIGTERM");
    };
    process.stdout.once("error", onTargetError);
    process.stderr.once("error", onTargetError);
    // Honor target backpressure: pause the child stream while the terminal or
    // pipe drains so a noisy follow stream cannot buffer without bound.
    const pipeWithBackpressure = (
      source: typeof child.stdout,
      targetStream: NodeJS.WriteStream,
      writer: ReturnType<typeof createRedactingStreamWriter>,
    ): void => {
      source?.on("data", (chunk: Buffer) => {
        if (!writer.write(chunk)) {
          source.pause();
          targetStream.once("drain", () => source.resume());
        }
      });
    };
    pipeWithBackpressure(child.stdout, process.stdout, stdout);
    pipeWithBackpressure(child.stderr, process.stderr, stderr);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      stdout.flush();
      stderr.flush();
      process.stdout.removeListener("error", onTargetError);
      process.stderr.removeListener("error", onTargetError);
      resolve({ code, signal });
    });
  });

function isMissingContainerError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("no such object") ||
    normalized.includes("no such container") ||
    normalized.includes("no container with name or id") ||
    /container .+ does not exist/u.test(normalized)
  );
}

function isMissingNetworkError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("no such network") ||
    normalized.includes("network not found") ||
    /network .+ not found/u.test(normalized) ||
    /network .+ does not exist/u.test(normalized)
  );
}

function validateNetworkName(networkName: string): string {
  const normalized = networkName.trim();
  if (!normalized || normalized.startsWith("-")) {
    throw new Error("Fleet network name is invalid.");
  }
  return normalized;
}

function validateContainerName(containerName: string): string {
  const normalized = containerName.trim();
  if (!normalized || normalized.startsWith("-")) {
    throw new Error("Fleet container name is invalid.");
  }
  return normalized;
}

function buildLogsArgs(containerName: string, options: FleetContainerLogsOptions): string[] {
  const args = ["logs"];
  if (options.follow) {
    args.push("--follow");
  }
  if (options.tail !== undefined) {
    if (!Number.isSafeInteger(options.tail) || options.tail < 1) {
      throw new Error("Fleet logs --tail must be a positive integer.");
    }
    args.push("--tail", String(options.tail));
  }
  if (options.since !== undefined) {
    if (!options.since || options.since.startsWith("-") || /[\s\p{Cc}]/u.test(options.since)) {
      throw new Error(
        "Fleet logs --since must be non-empty, must not start with '-', and must not contain whitespace or control characters.",
      );
    }
    args.push("--since", options.since);
  }
  args.push(validateContainerName(containerName));
  return args;
}
export function createFleetContainerRuntime(
  executor: FleetContainerCommandExecutor = defaultFleetContainerCommandExecutor,
  streamExecutor: FleetContainerStreamExecutor = defaultFleetContainerStreamExecutor,
) {
  const execute = async (
    runtime: FleetContainerRuntimeName,
    args: string[],
    options: FleetContainerCommandOptions = {},
  ): Promise<FleetContainerCommandResult> => {
    try {
      const result = await executor(runtime, args, options);
      if (result.code !== 0 && !options.allowFailure) {
        throw commandFailureError(runtime, args, result, options.redactValues);
      }
      return {
        ...result,
        stderr: redactEnvironmentValues(result.stderr, args, options.redactValues),
      };
    } catch (error) {
      throw formatExecutorError(error, runtime, args, options.redactValues);
    }
  };

  return {
    async assertLocal(runtime: FleetContainerRuntimeName): Promise<void> {
      if (runtime === "podman") {
        const result = await execute("podman", ["info", "--format", "json"]);
        if (parsePodmanServiceIsRemote(result.stdout)) {
          throw new Error("Fleet requires local Podman; remote cells are not supported.");
        }
        return;
      }

      // Docker exposes env-selected hosts as a virtual current context, including DOCKER_HOST.
      const result = await execute("docker", ["context", "inspect"]);
      const endpoint = parseDockerContextEndpoint(result.stdout);
      if (!isLocalDockerEndpoint(endpoint)) {
        throw new Error("Fleet requires a local Docker endpoint; remote cells are not supported.");
      }
    },

    async inspect(
      runtime: FleetContainerRuntimeName,
      containerName: string,
    ): Promise<FleetContainerInspectResult> {
      const args = ["container", "inspect", validateContainerName(containerName)];
      let result: FleetContainerCommandResult;
      try {
        result = await execute(runtime, args, { allowFailure: true });
      } catch (error) {
        return {
          kind: "unavailable",
          state: "unknown",
          error: formatExecutorError(error, runtime, args).message,
        };
      }
      if (result.code !== 0) {
        if (isMissingContainerError(result.stderr)) {
          return { kind: "missing", state: "missing" };
        }
        return {
          kind: "unavailable",
          state: "unknown",
          error: result.stderr.trim() || `${runtime} container inspect failed`,
        };
      }
      try {
        return parseInspectOutput(result.stdout);
      } catch {
        return {
          kind: "unavailable",
          state: "unknown",
          error: "container inspect returned an invalid response",
        };
      }
    },

    async inspectNetwork(
      runtime: FleetContainerRuntimeName,
      networkName: string,
    ): Promise<FleetNetworkInspectResult> {
      const args = ["network", "inspect", validateNetworkName(networkName)];
      let result: FleetContainerCommandResult;
      try {
        result = await execute(runtime, args, { allowFailure: true });
      } catch (error) {
        return {
          kind: "unavailable",
          error: formatExecutorError(error, runtime, args).message,
        };
      }
      if (result.code !== 0) {
        if (isMissingNetworkError(result.stderr)) {
          return { kind: "missing" };
        }
        return {
          kind: "unavailable",
          error: result.stderr.trim() || `${runtime} network inspect failed`,
        };
      }
      try {
        return parseNetworkInspectOutput(result.stdout);
      } catch {
        return {
          kind: "unavailable",
          error: "network inspect returned an invalid response",
        };
      }
    },

    async isDockerRootless(): Promise<boolean> {
      const result = await execute("docker", ["info", "--format", "{{json .SecurityOptions}}"]);
      return parseDockerRootlessInfo(result.stdout);
    },

    async run(profile: CellContainerProfile, start: boolean): Promise<void> {
      const tempRoot = await fs.realpath(os.tmpdir());
      const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-fleet-env-"));
      const environmentFile = path.join(tempDir, "cell.env");
      try {
        const args = start
          ? buildCellRunArgs(profile, { environmentFile })
          : buildCellCreateArgs(profile, { environmentFile });
        const content = Object.entries(profile.environment)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}\n`)
          .join("");
        await fs.writeFile(environmentFile, content, { encoding: "utf8", mode: 0o600 });
        await execute(profile.runtime, args, {
          redactValues: Object.values(profile.environment),
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },

    async pull(runtime: FleetContainerRuntimeName, image: string): Promise<void> {
      await execute(runtime, ["pull", validateFleetImage(image)]);
    },

    async createNetwork(
      runtime: FleetContainerRuntimeName,
      networkName: string,
      labels: Readonly<Record<string, string>>,
      options: { internal: boolean },
    ): Promise<void> {
      const labelArgs = Object.entries(labels)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, value]) => ["--label", `${key}=${value}`]);
      await execute(runtime, [
        "network",
        "create",
        "--driver",
        "bridge",
        ...(options.internal ? ["--internal"] : []),
        ...labelArgs,
        validateNetworkName(networkName),
      ]);
    },

    async removeNetwork(runtime: FleetContainerRuntimeName, networkName: string): Promise<void> {
      await execute(runtime, ["network", "rm", validateNetworkName(networkName)]);
    },

    async start(runtime: FleetContainerRuntimeName, containerName: string): Promise<void> {
      await execute(runtime, ["start", validateContainerName(containerName)]);
    },

    async stop(runtime: FleetContainerRuntimeName, containerName: string): Promise<void> {
      await execute(runtime, ["stop", validateContainerName(containerName)]);
    },

    async restart(runtime: FleetContainerRuntimeName, containerName: string): Promise<void> {
      await execute(runtime, ["restart", validateContainerName(containerName)]);
    },

    async logs(
      runtime: FleetContainerRuntimeName,
      containerName: string,
      options: FleetContainerLogsOptions,
    ): Promise<void> {
      const result = await streamExecutor(runtime, buildLogsArgs(containerName, options), {
        redactValues: options.redactValues,
      });
      if (result.code === 0) {
        return;
      }
      // A follow stream ended by a deliberate stop — a forwarded termination signal,
      // a closed downstream pipe, or docker/podman's own Ctrl-C translation to 130 —
      // is not a failure. Crash signals (SIGSEGV, SIGKILL, ...) stay errors.
      const deliberateStop =
        result.signal !== null && DELIBERATE_STREAM_STOP_SIGNALS.has(result.signal);
      if (options.follow && (deliberateStop || result.code === 130)) {
        return;
      }
      throw new Error(
        `${runtime} logs failed with ${
          result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 1}`
        }.`,
      );
    },

    async remove(
      runtime: FleetContainerRuntimeName,
      containerName: string,
      force: boolean,
    ): Promise<void> {
      await execute(runtime, [
        "rm",
        ...(force ? ["--force"] : []),
        validateContainerName(containerName),
      ]);
    },
  };
}
