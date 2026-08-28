#!/usr/bin/env -S node --import tsx

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const lifecycleModeSchema = z.enum(["crash", "graceful"]);
const lifecycleDependencySchema = z.enum(["gateway", "mock-openai", "telegram-proxy"]);
const lifecyclePhaseSchema = z.enum([
  "cancelled",
  "failed",
  "ready",
  "restart-requested",
  "starting",
]);
const requestIdSchema = z.string().uuid();
const containerIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const lifecycleRequestSchema = z
  .object({
    fromGeneration: z.number().int().positive(),
    id: requestIdSchema,
    mode: lifecycleModeSchema,
    readinessTimeoutSeconds: z.number().int().min(5).max(120),
  })
  .strict();
const lifecycleStateSchema = z
  .object({
    activeRequest: lifecycleRequestSchema.optional(),
    causedByRequestId: requestIdSchema.optional(),
    containerId: containerIdSchema.optional(),
    generation: z.number().int().positive(),
    mockContainerId: containerIdSchema.optional(),
    phase: lifecyclePhaseSchema,
    previousContainerId: containerIdSchema.optional(),
    proxyContainerId: containerIdSchema.optional(),
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
  })
  .strict();

type MantisLifecycleMode = z.infer<typeof lifecycleModeSchema>;
export type MantisLifecycleState = z.infer<typeof lifecycleStateSchema>;
type LifecycleRequest = z.infer<typeof lifecycleRequestSchema>;

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

type LifecycleCommand =
  | { containerId: string; generation: number; type: "started" }
  | { containerId: string; generation: number; type: "ready" }
  | { generation: number; type: "start-failed" }
  | { mockContainerId: string; proxyContainerId: string; type: "sidecars" }
  | {
      expectedGeneration: number;
      mode: MantisLifecycleMode;
      readinessTimeoutSeconds: number;
      requestId: string;
      type: "request";
    }
  | { requestId: string; type: "request-failed" }
  | {
      dependency: z.infer<typeof lifecycleDependencySchema>;
      requestId: string;
      type: "dependency-failed";
    }
  | { containerId: string; exitCode: number; generation: number; type: "exited" }
  | { containerId: string; generation: number; type: "readiness-failed" }
  | { type: "cancel" };

type MantisLifecycleEvent = {
  at: string;
  containerId?: string;
  dependency?: z.infer<typeof lifecycleDependencySchema>;
  event:
    | "gateway_exited"
    | "gateway_ready"
    | "gateway_readiness_failed"
    | "gateway_start_failed"
    | "gateway_started"
    | "gateway_starting"
    | "lifecycle_request_failed"
    | "lifecycle_dependency_failed"
    | "lifecycle_requested"
    | "sidecars_bound"
    | "runtime_cancelled";
  exitCode?: number;
  expected?: boolean;
  generation: number;
  mode?: MantisLifecycleMode;
  mockContainerId?: string;
  proxyContainerId?: string;
  requestId?: string;
  schemaVersion: 1;
  sequence: number;
  termination?: "forced" | "graceful";
};

type MantisLifecycleTransition = {
  events: MantisLifecycleEvent[];
  state: MantisLifecycleState;
};

const STATE_FILE = "lifecycle-state.json";
const EVIDENCE_FILE = "lifecycle-events.ndjson";

function requireGeneration(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function requireExitCode(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error("exit code must be between 0 and 255.");
  }
  return parsed;
}

function requireReadinessTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error("readiness timeout must be an integer.");
  }
  return z.number().int().min(5).max(120).parse(parsed);
}

function eventFor(
  state: MantisLifecycleState,
  at: string,
  event: MantisLifecycleEvent["event"],
  fields: Omit<
    MantisLifecycleEvent,
    "at" | "event" | "generation" | "schemaVersion" | "sequence"
  > & { generation?: number } = {},
): MantisLifecycleEvent {
  return withoutUndefined({
    at,
    event,
    generation: fields.generation ?? state.generation,
    schemaVersion: 1,
    sequence: state.sequence + 1,
    ...fields,
  });
}

function requireCurrentContainer(
  state: MantisLifecycleState,
  generation: number,
  containerId: string,
): void {
  if (state.generation !== generation) {
    throw new Error(
      `stale lifecycle generation: expected ${state.generation}, received ${generation}.`,
    );
  }
  if (!state.containerId || state.containerId !== containerId) {
    throw new Error("lifecycle container identity does not match the current generation.");
  }
}

function transitionEvent(
  state: MantisLifecycleState,
  event: MantisLifecycleEvent,
  patch: Partial<MantisLifecycleState>,
): MantisLifecycleTransition {
  return {
    events: [event],
    state: lifecycleStateSchema.parse(
      withoutUndefined({ ...state, ...patch, sequence: event.sequence }),
    ),
  };
}

export function createMantisLifecycleState(at: string): MantisLifecycleTransition {
  const initial: MantisLifecycleState = {
    generation: 1,
    phase: "starting",
    schemaVersion: 1,
    sequence: 1,
  };
  return {
    events: [
      {
        at,
        event: "gateway_starting",
        generation: 1,
        schemaVersion: 1,
        sequence: 1,
      },
    ],
    state: initial,
  };
}

export function transitionMantisLifecycle(
  input: MantisLifecycleState,
  command: LifecycleCommand,
  at: string,
): MantisLifecycleTransition {
  const state = lifecycleStateSchema.parse(input);
  if (command.type === "cancel") {
    if (state.phase === "cancelled" || state.phase === "failed") {
      return { events: [], state };
    }
    const event = eventFor(state, at, "runtime_cancelled", {
      containerId: state.containerId,
      requestId: state.activeRequest?.id ?? state.causedByRequestId,
    });
    return transitionEvent(state, event, { phase: "cancelled" });
  }
  if (state.phase === "cancelled" || state.phase === "failed") {
    throw new Error(`cannot apply ${command.type} to terminal lifecycle phase ${state.phase}.`);
  }

  if (command.type === "started") {
    if (
      state.phase !== "starting" ||
      state.containerId ||
      !state.mockContainerId ||
      !state.proxyContainerId
    ) {
      throw new Error("gateway started is valid only for an unbound starting generation.");
    }
    if (state.generation !== command.generation) {
      throw new Error(
        `stale lifecycle generation: expected ${state.generation}, received ${command.generation}.`,
      );
    }
    const containerId = containerIdSchema.parse(command.containerId);
    if (containerId === state.previousContainerId) {
      throw new Error("replacement gateway reused the previous container identity.");
    }
    const event = eventFor(state, at, "gateway_started", {
      containerId,
      requestId: state.causedByRequestId,
    });
    return transitionEvent(state, event, { containerId });
  }

  if (command.type === "sidecars") {
    if (
      state.phase !== "starting" ||
      state.generation !== 1 ||
      state.containerId ||
      state.mockContainerId ||
      state.proxyContainerId
    ) {
      throw new Error("sidecar identity can be bound only once before the initial Gateway.");
    }
    const mockContainerId = containerIdSchema.parse(command.mockContainerId);
    const proxyContainerId = containerIdSchema.parse(command.proxyContainerId);
    if (mockContainerId === proxyContainerId) {
      throw new Error("Mantis sidecars must have distinct container identities.");
    }
    const event = eventFor(state, at, "sidecars_bound", {
      mockContainerId,
      proxyContainerId,
    });
    return transitionEvent(state, event, { mockContainerId, proxyContainerId });
  }

  if (command.type === "start-failed") {
    if (state.phase !== "starting" || state.containerId) {
      throw new Error("gateway start failure requires an unbound starting generation.");
    }
    if (state.generation !== command.generation) {
      throw new Error(
        `stale lifecycle generation: expected ${state.generation}, received ${command.generation}.`,
      );
    }
    const event = eventFor(state, at, "gateway_start_failed", {
      requestId: state.causedByRequestId,
    });
    return transitionEvent(state, event, { phase: "failed" });
  }

  if (command.type === "ready") {
    if (state.phase !== "starting") {
      throw new Error("gateway ready is valid only for a starting generation.");
    }
    requireCurrentContainer(state, command.generation, command.containerId);
    const event = eventFor(state, at, "gateway_ready", {
      containerId: command.containerId,
      requestId: state.causedByRequestId,
    });
    return transitionEvent(state, event, { phase: "ready", previousContainerId: undefined });
  }

  if (command.type === "request") {
    if (state.phase !== "ready" || !state.containerId) {
      throw new Error("gateway lifecycle action requires a ready generation.");
    }
    if (state.generation !== command.expectedGeneration) {
      throw new Error(
        `stale lifecycle generation: expected ${state.generation}, received ${command.expectedGeneration}.`,
      );
    }
    const request: LifecycleRequest = lifecycleRequestSchema.parse({
      fromGeneration: command.expectedGeneration,
      id: command.requestId,
      mode: command.mode,
      readinessTimeoutSeconds: command.readinessTimeoutSeconds,
    });
    const event = eventFor(state, at, "lifecycle_requested", {
      containerId: state.containerId,
      mode: request.mode,
      requestId: request.id,
    });
    return transitionEvent(state, event, {
      activeRequest: request,
      causedByRequestId: undefined,
      phase: "restart-requested",
    });
  }

  if (command.type === "request-failed") {
    if (state.phase !== "restart-requested" || state.activeRequest?.id !== command.requestId) {
      throw new Error("lifecycle request failure does not match the active request.");
    }
    const event = eventFor(state, at, "lifecycle_request_failed", {
      containerId: state.containerId,
      mode: state.activeRequest.mode,
      requestId: command.requestId,
    });
    return transitionEvent(state, event, { activeRequest: undefined, phase: "ready" });
  }

  if (command.type === "dependency-failed") {
    if (state.phase !== "ready" || state.causedByRequestId !== command.requestId) {
      throw new Error("lifecycle dependency failure does not match the ready successor.");
    }
    const event = eventFor(state, at, "lifecycle_dependency_failed", {
      containerId: state.containerId,
      dependency: command.dependency,
      requestId: command.requestId,
    });
    return transitionEvent(state, event, { phase: "failed" });
  }

  if (command.type === "readiness-failed") {
    if (state.phase !== "starting") {
      throw new Error("readiness failure is valid only for a starting generation.");
    }
    if (state.generation !== command.generation) {
      throw new Error(
        `stale lifecycle generation: expected ${state.generation}, received ${command.generation}.`,
      );
    }
    if (!state.containerId || state.containerId !== command.containerId) {
      throw new Error("lifecycle container identity does not match the current generation.");
    }
    const event = eventFor(state, at, "gateway_readiness_failed", {
      containerId: command.containerId,
      requestId: state.causedByRequestId,
    });
    return transitionEvent(state, event, { phase: "failed" });
  }

  requireCurrentContainer(state, command.generation, command.containerId);
  const request = state.phase === "restart-requested" ? state.activeRequest : undefined;
  const exited = eventFor(state, at, "gateway_exited", {
    containerId: command.containerId,
    exitCode: command.exitCode,
    expected: Boolean(request),
    mode: request?.mode,
    requestId: request?.id,
    termination: request
      ? request.mode === "crash" || command.exitCode === 137
        ? "forced"
        : "graceful"
      : undefined,
  });
  if (!request) {
    return transitionEvent(state, exited, { phase: "failed" });
  }
  const starting: MantisLifecycleEvent = {
    at,
    event: "gateway_starting",
    generation: state.generation + 1,
    requestId: request.id,
    schemaVersion: 1,
    sequence: exited.sequence + 1,
  };
  return {
    events: [exited, starting],
    state: lifecycleStateSchema.parse({
      causedByRequestId: request.id,
      generation: state.generation + 1,
      mockContainerId: state.mockContainerId,
      phase: "starting",
      previousContainerId: state.containerId,
      proxyContainerId: state.proxyContainerId,
      schemaVersion: 1,
      sequence: starting.sequence,
    }),
  };
}

interface MantisLifecycleRuntimeStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  uid: number;
}

export function isRootOwnedMantisLifecycleRuntime(stat: MantisLifecycleRuntimeStat): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === 0 &&
    (stat.mode & 0o1777) === 0o1770
  );
}

function requireRootRuntime(runtimeRoot: string): string {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Mantis lifecycle controller must run as root on Linux.");
  }
  const resolved = fs.realpathSync(runtimeRoot);
  const stat = fs.lstatSync(resolved);
  if (!isRootOwnedMantisLifecycleRuntime(stat)) {
    throw new Error("the Mantis lifecycle runtime must be a root-owned 1770 directory.");
  }
  return resolved;
}

function assertRootEvidenceFile(file: string, mode: number): void {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== mode
  ) {
    throw new Error(`invalid root-owned lifecycle file: ${path.basename(file)}.`);
  }
}

function statePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, STATE_FILE);
}

function evidencePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, EVIDENCE_FILE);
}

export function validateMantisLifecycleJournal(
  inputState: MantisLifecycleState,
  evidence: string,
): void {
  const state = lifecycleStateSchema.parse(inputState);
  if (Buffer.byteLength(evidence) > 1024 * 1024) {
    throw new Error("Mantis lifecycle evidence exceeded 1 MiB.");
  }
  const events = evidence
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      z
        .object({
          event: z.string(),
          generation: z.number().int().positive(),
          sequence: z.number().int().positive(),
        })
        .passthrough()
        .parse(JSON.parse(line)),
    );
  if (
    events.length === 0 ||
    events.some((event, index) => event.sequence !== index + 1) ||
    events.at(-1)?.sequence !== state.sequence ||
    events.at(-1)?.generation !== state.generation
  ) {
    // State and journal are a coupled root-owned commit. Refuse another transition after
    // an interrupted write; reusing the stale sequence would make the proof ambiguous.
    throw new Error("Mantis lifecycle state and evidence journal are inconsistent.");
  }
  const expectedPhase =
    {
      gateway_ready: "ready",
      gateway_readiness_failed: "failed",
      gateway_start_failed: "failed",
      gateway_started: "starting",
      gateway_starting: "starting",
      lifecycle_request_failed: "ready",
      lifecycle_dependency_failed: "failed",
      lifecycle_requested: "restart-requested",
      runtime_cancelled: "cancelled",
      sidecars_bound: "starting",
    }[events.at(-1)?.event ?? ""] ?? "failed";
  if (state.phase !== expectedPhase) {
    throw new Error("Mantis lifecycle state and evidence journal are inconsistent.");
  }
}

function readLifecycleState(runtimeRoot: string): MantisLifecycleState {
  const file = statePath(runtimeRoot);
  assertRootEvidenceFile(file, 0o400);
  const state = lifecycleStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const eventsFile = evidencePath(runtimeRoot);
  assertRootEvidenceFile(eventsFile, 0o444);
  validateMantisLifecycleJournal(state, fs.readFileSync(eventsFile, "utf8"));
  return state;
}

function writeLifecycleState(runtimeRoot: string, state: MantisLifecycleState): void {
  const file = statePath(runtimeRoot);
  const temp = path.join(runtimeRoot, `.lifecycle-state.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o400 });
  fs.chmodSync(temp, 0o400);
  fs.renameSync(temp, file);
  assertRootEvidenceFile(file, 0o400);
}

function appendLifecycleEvents(runtimeRoot: string, events: MantisLifecycleEvent[]): void {
  if (events.length === 0) {
    return;
  }
  const file = evidencePath(runtimeRoot);
  assertRootEvidenceFile(file, 0o444);
  fs.appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assertRootEvidenceFile(file, 0o444);
}

function initializeLifecycleStore(runtimeRoot: string, at: string): MantisLifecycleTransition {
  const stateFile = statePath(runtimeRoot);
  const eventsFile = evidencePath(runtimeRoot);
  if (fs.existsSync(stateFile) || fs.existsSync(eventsFile)) {
    throw new Error("Mantis lifecycle evidence already exists.");
  }
  fs.writeFileSync(eventsFile, "", { flag: "wx", mode: 0o444 });
  fs.chmodSync(eventsFile, 0o444);
  assertRootEvidenceFile(eventsFile, 0o444);
  const transition = createMantisLifecycleState(at);
  writeLifecycleState(runtimeRoot, transition.state);
  appendLifecycleEvents(runtimeRoot, transition.events);
  return transition;
}

function applyLifecycleStore(
  runtimeRoot: string,
  command: LifecycleCommand,
  at: string,
): MantisLifecycleTransition {
  const transition = transitionMantisLifecycle(readLifecycleState(runtimeRoot), command, at);
  appendLifecycleEvents(runtimeRoot, transition.events);
  writeLifecycleState(runtimeRoot, transition.state);
  return transition;
}

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function lifecycleUsage(): string {
  return [
    "usage: mantis-sut-lifecycle-controller <command> <runtime-root> ...",
    "commands: initialize, sidecars, started, start-failed, ready, request, request-failed, dependency-failed, exited, readiness-failed, cancel, status",
  ].join("\n");
}

function runMantisLifecycleController(argv: string[], now = () => new Date().toISOString()): void {
  const [command, inputRoot, ...args] = argv;
  if (!command || !inputRoot) {
    throw new Error(lifecycleUsage());
  }
  const runtimeRoot = requireRootRuntime(inputRoot);
  if (command === "initialize" && args.length === 0) {
    outputJson(initializeLifecycleStore(runtimeRoot, now()).state);
    return;
  }
  if (command === "status" && args.length === 0) {
    outputJson(readLifecycleState(runtimeRoot));
    return;
  }
  if (command === "cancel" && args.length === 0) {
    outputJson(applyLifecycleStore(runtimeRoot, { type: "cancel" }, now()).state);
    return;
  }
  if (command === "started" && args.length === 2) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          containerId: containerIdSchema.parse(args[1]),
          generation: requireGeneration(args[0] ?? "", "generation"),
          type: "started",
        },
        now(),
      ).state,
    );
    return;
  }
  if (command === "sidecars" && args.length === 2) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          mockContainerId: containerIdSchema.parse(args[0]),
          proxyContainerId: containerIdSchema.parse(args[1]),
          type: "sidecars",
        },
        now(),
      ).state,
    );
    return;
  }
  if (command === "start-failed" && args.length === 1) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        { generation: requireGeneration(args[0] ?? "", "generation"), type: "start-failed" },
        now(),
      ).state,
    );
    return;
  }
  if (command === "ready" && args.length === 2) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          containerId: containerIdSchema.parse(args[1]),
          generation: requireGeneration(args[0] ?? "", "generation"),
          type: "ready",
        },
        now(),
      ).state,
    );
    return;
  }
  if (command === "request" && args.length === 4) {
    const requestId = requestIdSchema.parse(args[3]);
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          expectedGeneration: requireGeneration(args[0] ?? "", "expected generation"),
          mode: lifecycleModeSchema.parse(args[1]),
          readinessTimeoutSeconds: requireReadinessTimeout(args[2] ?? ""),
          requestId,
          type: "request",
        },
        now(),
      ).state,
    );
    return;
  }
  if (command === "request-failed" && args.length === 1) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        { requestId: requestIdSchema.parse(args[0]), type: "request-failed" },
        now(),
      ).state,
    );
    return;
  }
  if (command === "dependency-failed" && args.length === 2) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          dependency: lifecycleDependencySchema.parse(args[1]),
          requestId: requestIdSchema.parse(args[0]),
          type: "dependency-failed",
        },
        now(),
      ).state,
    );
    return;
  }
  if (command === "exited" && args.length === 3) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          containerId: containerIdSchema.parse(args[1]),
          exitCode: requireExitCode(args[2] ?? ""),
          generation: requireGeneration(args[0] ?? "", "generation"),
          type: "exited",
        },
        now(),
      ).state,
    );
    return;
  }
  if (command === "readiness-failed" && args.length === 2) {
    outputJson(
      applyLifecycleStore(
        runtimeRoot,
        {
          containerId: containerIdSchema.parse(args[1]),
          generation: requireGeneration(args[0] ?? "", "generation"),
          type: "readiness-failed",
        },
        now(),
      ).state,
    );
    return;
  }
  throw new Error(lifecycleUsage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runMantisLifecycleController(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
