import path from "node:path";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  crabboxCommandError,
  permanentCrabboxCommandError,
} from "./crabbox-worker-command-error.js";
import {
  type CrabboxCommandRunner,
  isAuthoritativeLeaseAbsence,
  provisionProfileError,
  runCrabboxCommand,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";
import { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import {
  buildCrabboxWarmupArgs,
  identityRefId,
  listCrabboxMachineOptions,
  nonEmptyString,
  operationLeaseId,
  operationSlug,
  parseCrabboxProfile,
  resolveCrabboxBinary,
} from "./crabbox-worker-profile.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  CRABBOX_WARMUP_TIMEOUT_MS,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
} from "./crabbox-worker-timeouts.js";

export { resolveOpenClawRoot } from "./crabbox-worker-profile.js";

const CRABBOX_WORKER_PROVIDER_ID = "crabbox";
const CRABBOX_KEY_REF_PROVIDER = "crabbox";

const READY_POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_DETAIL_CHARS = 512;
const CLOUD_SETUP_CODE_ENV = "CRABBOX_WORKER_SETUP_CODE";
// Only states that prove the resource is gone or stopped map to `destroyed`. Crabbox also
// treats `deleting` and `failed` as unable to become ready, but those can retain resources
// that still need an explicit stop during teardown.
const DESTROYED_STATES = new Set([
  "deleted",
  "destroyed",
  "expired",
  "missing",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
]);
const UNUSABLE_PROVISION_STATES = new Set([...DESTROYED_STATES, "deleting", "failed"]);
const LEASE_ID_PATTERN = /^(?:cbx_|tbx_)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEGACY_PROVISION_OPERATION_ID_PATTERN = /^provision:[a-f0-9]{64}$/u;

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type WorkerNodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

type LeaseCommandContext = { binary: string; id: string; provider: string };
type LeaseHeartbeatContext = LeaseCommandContext &
  Pick<CrabboxProfile, "heartbeatIntervalMs" | "idleTimeout">;
type ProvisionInspectContext = Omit<LeaseCommandContext, "id"> & {
  deadline: number;
  inspect: ParsedInspect;
  profile: CrabboxProfile;
  runCommand: CrabboxCommandRunner;
};

type InspectCommandResult = { status: "found"; inspect: ParsedInspect } | { status: "unknown" };

type CrabboxWorkerProviderDependencies = {
  isExecutable?: (candidate: string) => boolean;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand?: CrabboxCommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
};

async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw permanentCrabboxCommandError("config show", result);
  }
  let instanceProfile: unknown;
  try {
    const config: unknown = JSON.parse(result.stdout);
    instanceProfile =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as { aws?: { instanceProfile?: unknown } }).aws?.instanceProfile
        : undefined;
  } catch {
    throw new WorkerProviderError("Crabbox config show returned invalid JSON");
  }
  if (typeof instanceProfile !== "string") {
    throw new WorkerProviderError("Crabbox config show returned an invalid AWS instance profile");
  }
  if (nonEmptyString(instanceProfile)) {
    throw new WorkerProviderError("Crabbox AWS instance profile must be empty for cloud workers");
  }
}

async function inspectWithContext(params: {
  context: Omit<LeaseCommandContext, "id">;
  expectedLeaseId?: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
}): Promise<InspectCommandResult> {
  const result = await runCrabboxCommand({
    action: "inspect",
    args: [
      "inspect",
      "--provider",
      params.context.provider,
      "--network",
      "public",
      "--id",
      params.id,
      "--json",
    ],
    binary: params.context.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    // A successful but malformed response cannot attest the fixed lease. Command failures and
    // authoritative absence remain transient so Gateway replay can inspect the live lease later.
    let inspect: ParsedInspect;
    try {
      inspect = parseInspectJson(result.stdout);
    } catch (error) {
      throw new WorkerProviderError(
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output",
      );
    }
    if (params.expectedLeaseId && inspect.id !== params.expectedLeaseId) {
      throw new WorkerProviderError("Crabbox inspect returned a different lease id");
    }
    return { status: "found", inspect };
  }
  if (result.termination === "exit" && isAuthoritativeLeaseAbsence(result, params.id)) {
    return { status: "unknown" };
  }
  throw crabboxCommandError("inspect", result);
}

function remainingProvisionTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Crabbox provision exceeded its provider deadline");
  }
  return Math.min(maximum, remaining);
}

const isTerminalState = (state: string) => DESTROYED_STATES.has(state.toLowerCase());
const isUnusableProvisionState = (state: string) =>
  UNUSABLE_PROVISION_STATES.has(state.toLowerCase());

function assertProvisionSecurityPolicy(params: { inspect: ParsedInspect; provider: string }): void {
  if (params.inspect.tailscaleEnabled) {
    throw new WorkerProviderError("Crabbox cloud worker lease must not have Tailscale enabled");
  }
  const attached = params.inspect.awsInstanceProfileAttached;
  const pending = !params.inspect.ready && !isUnusableProvisionState(params.inspect.state);
  if (params.provider === "aws" && attached !== false && (attached || !pending)) {
    throw new WorkerProviderError(
      "Crabbox AWS inspect must attest that no instance profile is attached",
    );
  }
}

async function waitForProvisionReady(
  params: ProvisionInspectContext & {
    refresh?: boolean;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<ParsedInspect> {
  let inspect = params.inspect;
  const inspectAgain = async (): Promise<ParsedInspect> => {
    const replay = await inspectWithContext({
      context: { binary: params.binary, provider: params.provider },
      expectedLeaseId: inspect.id,
      id: inspect.id,
      runCommand: params.runCommand,
      timeoutMs: remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS),
    });
    if (replay.status === "unknown") {
      throw new Error("Crabbox operation lease disappeared while waiting for SSH readiness");
    }
    return replay.inspect;
  };
  try {
    inspect = params.refresh ? await inspectAgain() : params.inspect;
    // Reject forbidden state immediately; omitted AWS metadata is pending only until ready.
    assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    while (inspect.ready !== true && !isUnusableProvisionState(inspect.state)) {
      const remaining = remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS);
      await params.sleep(Math.min(READY_POLL_INTERVAL_MS, remaining));
      inspect = await inspectAgain();
      assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    }
    if (isUnusableProvisionState(inspect.state)) {
      throw new WorkerProviderError(
        "Crabbox operation lease entered a terminal state while waiting for SSH",
      );
    }
    return inspect;
  } catch (error) {
    if (error instanceof WorkerProviderError) {
      await stopProvisionInspect({ ...params, inspect });
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nodeEnrollmentSetupCommand(params: {
  enrollment: WorkerNodeEnrollment;
  leaseId: string;
}): string {
  const { enrollment, leaseId } = params;
  const stateDir = `.openclaw/cloud-workers/${leaseId}`;
  const packageCandidates = enrollment.packageSpecs.map(shellQuote).join(" ");
  if (!packageCandidates) {
    throw new Error("Worker node enrollment has no OpenClaw package source");
  }
  const versionLabel = shellQuote(`OpenClaw ${enrollment.openclawVersion}`);
  const versionMetadataPrefix = shellQuote(`OpenClaw ${enrollment.openclawVersion} `);
  const setupCodeLines =
    enrollment.mode === "connect"
      ? [
          'setup_code_file="$state_dir/setup-code"',
          "umask 077",
          `printf "%s\\n" "$${CLOUD_SETUP_CODE_ENV}" >"$setup_code_file"`,
        ]
      : [];
  const launch =
    enrollment.mode === "connect"
      ? `connect --target-file "$setup_code_file" --ephemeral --display-name ${shellQuote(enrollment.displayName)}`
      : `node run --ephemeral --display-name ${shellQuote(enrollment.displayName)}`;
  return [
    "set -eu",
    `state_dir="$HOME/${stateDir}"`,
    'mkdir -p "$state_dir"',
    'chmod 700 "$state_dir"',
    'pid_file="$state_dir/node.pid"',
    'package_spec_file="$state_dir/package-spec"',
    'if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then exit 0; fi',
    ...setupCodeLines,
    "if command -v openclaw >/dev/null 2>&1; then",
    '  case "$(openclaw --version 2>/dev/null || true)" in',
    `    ${versionLabel}|${versionMetadataPrefix}*) printf "%s\\n" "@global" >"$package_spec_file" ;;`,
    "  esac",
    "fi",
    'if [ ! -s "$package_spec_file" ]; then',
    '  rm -f "$package_spec_file"',
    `  for package_candidate in ${packageCandidates}; do`,
    '    if OPENCLAW_STATE_DIR="$state_dir" npx --yes --package "$package_candidate" -- openclaw --version >/dev/null 2>&1; then',
    '      printf "%s\\n" "$package_candidate" >"$package_spec_file"',
    "      break",
    "    fi",
    "  done",
    "fi",
    'test -s "$package_spec_file"',
    'package_spec="$(cat "$package_spec_file")"',
    'if [ "$package_spec" = "@global" ]; then',
    `  setsid -f sh -c 'printf "%s\\n" "$$" >"$1"; shift; exec "$@"' sh "$pid_file" env OPENCLAW_STATE_DIR="$state_dir" openclaw ${launch} >"$state_dir/node.log" 2>&1 </dev/null`,
    "else",
    `  setsid -f sh -c 'printf "%s\\n" "$$" >"$1"; shift; exec "$@"' sh "$pid_file" env OPENCLAW_STATE_DIR="$state_dir" npx --yes --package "$package_spec" -- openclaw ${launch} >"$state_dir/node.log" 2>&1 </dev/null`,
    "fi",
    'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$pid_file" ] && break; sleep 0.1; done',
    'test -s "$pid_file"',
  ].join("\n");
}

// Setup runs on every provision attempt (including replay adoption), so commands
// must be idempotent. A failed setup stops the lease before surfacing the error;
// otherwise the caller cannot release a box it never learned about.
async function runProvisionSetup(
  params: ProvisionInspectContext & {
    setup: string;
    timeoutMs?: number;
    forwardedEnv?: Record<string, string>;
  },
): Promise<void> {
  let result: SpawnResult;
  try {
    result = await runCrabboxCommand({
      action: "setup",
      args: [
        "run",
        "--provider",
        params.provider,
        "--network",
        "public",
        "--tailscale=false",
        "--id",
        params.inspect.id,
        "--keep=true",
        // Workspace transfer is owned by the worker tunnel; crabbox run must not
        // rsync the gateway checkout into the box just to execute setup.
        "--no-sync",
        ...Object.keys(params.forwardedEnv ?? {}).flatMap((name) => ["--allow-env", name]),
        "--script-stdin",
      ],
      binary: params.binary,
      env: params.forwardedEnv,
      input: params.setup,
      runCommand: params.runCommand,
      timeoutMs: remainingProvisionTimeout(
        params.deadline,
        params.timeoutMs ?? CRABBOX_SETUP_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    await stopProvisionInspect(params);
    throw error;
  }
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  const error = permanentCrabboxCommandError("setup", result);
  await stopProvisionInspect(params);
  throw error;
}

async function runProvisionSetupAndWaitReady(
  params: ProvisionInspectContext & {
    setup: string;
    timeoutMs?: number;
    forwardedEnv?: Record<string, string>;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<ParsedInspect> {
  await runProvisionSetup(params);
  // Setup may restart SSH or change its endpoint. Re-read the authoritative lease before
  // returning any endpoint or security attestation to core bootstrap.
  return await waitForProvisionReady({ ...params, refresh: true });
}

async function stopProvisionInspect(params: ProvisionInspectContext): Promise<void> {
  await stopProvisionId({ ...params, id: params.inspect.id });
}

async function stopProvisionId(params: {
  binary: string;
  id: string;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  await stopCrabboxLease({
    binary: params.binary,
    id: params.id,
    provider: params.provider,
    runCommand: params.runCommand,
    // Cleanup gets its own budget so an exhausted provision deadline cannot leak a lease.
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
}

function transientAwsProfileCleanupError(
  profileError: WorkerProviderError,
  action: "inspect" | "stop",
  cleanupError: unknown,
): Error {
  const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  const message = `Crabbox AWS profile rejection cleanup is indeterminate during ${action}: ${cleanupDetail}; rejection: ${profileError.message}`;
  return new Error(
    truncateUtf16Safe(redactSensitiveText(message).replace(/\s+/gu, " "), MAX_ERROR_DETAIL_CHARS),
    { cause: cleanupError },
  );
}

async function rejectAwsProfileAfterLeaseReconciliation(
  context: LeaseCommandContext,
  profileError: WorkerProviderError,
  runCommand: CrabboxCommandRunner,
): Promise<never> {
  let inspected: InspectCommandResult | undefined;
  let invalidInspect: WorkerProviderError | undefined;
  try {
    inspected = await inspectWithContext({
      context,
      expectedLeaseId: context.id,
      id: context.id,
      runCommand,
    });
  } catch (error) {
    if (!(error instanceof WorkerProviderError)) {
      throw transientAwsProfileCleanupError(profileError, "inspect", error);
    }
    invalidInspect = error;
  }
  if (!invalidInspect && inspected?.status === "unknown") {
    throw profileError;
  }
  try {
    await stopCrabboxLease({ ...context, runCommand });
  } catch (error) {
    const detail = invalidInspect
      ? new AggregateError([invalidInspect, error], "invalid inspect and stop failed")
      : error;
    throw transientAwsProfileCleanupError(profileError, "stop", detail);
  }
  throw profileError;
}

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies = {},
): WorkerProvider {
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const openclawRoot = dependencies.openclawRoot ?? process.cwd();
  const heartbeats = createCrabboxHeartbeatManager({
    run: (context, signal) =>
      runCrabboxCommand({
        action: "heartbeat",
        args: [
          "heartbeat",
          "--provider",
          context.provider,
          "--id",
          context.id,
          "--idle-timeout",
          context.idleTimeout,
          "--json",
        ],
        binary: context.binary,
        runCommand,
        signal,
        timeoutMs: Math.min(CRABBOX_LIFECYCLE_TIMEOUT_MS, context.heartbeatIntervalMs),
      }),
    warn: dependencies.warn ?? (() => {}),
  });
  let defaultBinary: string | undefined;
  const resolveBinary = (explicit?: string) => {
    if (explicit) {
      return explicit;
    }
    defaultBinary ??= resolveCrabboxBinary({
      explicit,
      isExecutable: dependencies.isExecutable,
      openclawRoot,
      pathEnv: dependencies.pathEnv ?? process.env.PATH,
      platform: dependencies.platform,
    });
    return defaultBinary;
  };
  const resolveLeaseContext = (
    lease: Parameters<WorkerProvider["inspect"]>[0],
  ): LeaseHeartbeatContext => {
    const parsed = parseCrabboxProfile(lease.profile);
    if (!LEASE_ID_PATTERN.test(lease.leaseId)) {
      throw new Error("Crabbox lease id is invalid");
    }
    return {
      binary: resolveBinary(parsed.binary),
      heartbeatIntervalMs: parsed.heartbeatIntervalMs,
      id: lease.leaseId,
      idleTimeout: parsed.idleTimeout,
      provider: parsed.provider,
    };
  };

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    listMachineOptions: listCrabboxMachineOptions,
    supportedExecutionModes: ["worker-turn"],
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    resolveProvisionTimeoutMs(profile) {
      return resolveCrabboxProvisionCallTimeoutMs(parseCrabboxProfile(profile));
    },
    async provision(
      profile: WorkerProfile,
      operationId: string,
      options: Parameters<WorkerProvider["provision"]>[2],
    ): Promise<WorkerLease> {
      const configured = parseCrabboxProfile(profile);
      const requestedClass = nonEmptyString(options?.machineClass);
      if (options?.machineClass !== undefined && (!requestedClass || requestedClass.length > 128)) {
        throw new WorkerProviderError(
          "Crabbox machine class must be a non-empty string of at most 128 characters",
        );
      }
      const parsed = requestedClass ? { ...configured, class: requestedClass } : configured;
      if (parsed.desktop) {
        throw new WorkerProviderError(
          "Crabbox desktop profiles are unavailable after node transport convergence",
        );
      }
      const warmupTimeoutMs = CRABBOX_WARMUP_TIMEOUT_MS;
      const deadline = Date.now() + resolveCrabboxProvisionBaseTimeoutMs(parsed);
      const setupDeadline =
        deadline +
        countCrabboxProvisionSetupPhases(parsed) * CRABBOX_SETUP_TIMEOUT_MS +
        CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS;
      if (!operationId.trim()) {
        throw new Error("Crabbox provision requires an operation id");
      }
      if (LEGACY_PROVISION_OPERATION_ID_PATTERN.test(operationId)) {
        throw new WorkerProviderError(
          "Legacy Crabbox provision state cannot be replayed safely; clean up any prior lease and dispatch again",
        );
      }
      const binary = resolveBinary(parsed.binary);
      const context = { binary, provider: parsed.provider };
      const leaseId = operationLeaseId(operationId);
      const slug = operationSlug(operationId);
      if (parsed.provider === "aws") {
        try {
          await assertAwsWorkerHasNoInstanceProfile({ binary, runCommand });
        } catch (error) {
          if (!(error instanceof WorkerProviderError)) {
            throw error;
          }
          await rejectAwsProfileAfterLeaseReconciliation(
            { binary, id: leaseId, provider: parsed.provider },
            error,
            runCommand,
          );
        }
      }

      const warmup = await runCrabboxCommand({
        action: "warmup",
        args: buildCrabboxWarmupArgs(parsed, leaseId, slug),
        binary,
        runCommand,
        timeoutMs: remainingProvisionTimeout(deadline, warmupTimeoutMs),
      });
      if (warmup.termination !== "exit" || warmup.code !== 0) {
        const profileError = provisionProfileError(warmup);
        if (profileError) {
          throw profileError;
        }
        throw crabboxCommandError("warmup", warmup);
      }
      let inspected: InspectCommandResult;
      try {
        inspected = await inspectWithContext({
          context,
          expectedLeaseId: leaseId,
          id: leaseId,
          runCommand,
          timeoutMs: remainingProvisionTimeout(deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS),
        });
      } catch (error) {
        // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
        if (error instanceof WorkerProviderError) {
          await stopProvisionId({ binary, id: leaseId, provider: parsed.provider, runCommand });
        }
        throw error;
      }
      if (inspected.status === "unknown") {
        throw new Error("Crabbox warmup lease was not found during inspection");
      }
      const inspectedParams = {
        binary,
        deadline,
        inspect: inspected.inspect,
        profile: parsed,
        provider: parsed.provider,
        runCommand,
      };
      if (isUnusableProvisionState(inspected.inspect.state)) {
        await stopProvisionInspect(inspectedParams);
        throw new WorkerProviderError("Crabbox warmup lease entered a terminal state");
      }
      inspectedParams.inspect = await waitForProvisionReady({ ...inspectedParams, sleep });
      inspectedParams.deadline = setupDeadline;
      if (parsed.setup) {
        inspectedParams.inspect = await runProvisionSetupAndWaitReady({
          ...inspectedParams,
          setup: parsed.setup,
          sleep,
        });
      }
      const beginNodeEnrollment = options?.beginNodeEnrollment;
      if (!beginNodeEnrollment) {
        throw new Error("Crabbox worker node enrollment is unavailable");
      }
      const enrollment = await beginNodeEnrollment();
      inspectedParams.inspect = await runProvisionSetupAndWaitReady({
        ...inspectedParams,
        setup: nodeEnrollmentSetupCommand({ enrollment, leaseId }),
        timeoutMs: CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS,
        ...(enrollment.mode === "connect"
          ? { forwardedEnv: { [CLOUD_SETUP_CODE_ENV]: enrollment.setupCode } }
          : {}),
        sleep,
      });
      const deviceId = await enrollment.waitForDeviceId();
      heartbeats.start({
        binary,
        heartbeatIntervalMs: parsed.heartbeatIntervalMs,
        id: leaseId,
        idleTimeout: parsed.idleTimeout,
        provider: parsed.provider,
      });
      return {
        leaseId,
        node: { deviceId },
        sharedHost: false,
      };
    },
    async inspect(lease): Promise<WorkerLeaseStatus> {
      const context = resolveLeaseContext(lease);
      const inspected = await inspectWithContext({
        context,
        expectedLeaseId: context.id,
        id: context.id,
        runCommand,
      });
      if (inspected.status === "unknown") {
        heartbeats.stop(context.id);
        return { status: "unknown" };
      }
      // `ready` is an SSH probe; every recognized nonterminal lease remains active.
      if (isTerminalState(inspected.inspect.state)) {
        heartbeats.stop(context.id);
        return { status: "destroyed" };
      }
      heartbeats.start(context);
      return { status: "active" };
    },
    async resolveSshIdentity(request) {
      const context = resolveLeaseContext(request);
      if (
        request.keyRef.source !== "file" ||
        request.keyRef.provider !== CRABBOX_KEY_REF_PROVIDER ||
        request.keyRef.id !== identityRefId(context.id)
      ) {
        throw new Error("Crabbox worker identity reference does not match its lease");
      }
      const inspected = await inspectWithContext({
        context,
        expectedLeaseId: context.id,
        id: context.id,
        runCommand,
      });
      if (
        inspected.status === "unknown" ||
        isTerminalState(inspected.inspect.state) ||
        !inspected.inspect.sshKey
      ) {
        throw new Error("Crabbox inspect did not return the worker identity path");
      }
      if (!path.isAbsolute(inspected.inspect.sshKey)) {
        throw new Error("Crabbox inspect returned a non-absolute worker identity path");
      }
      return { kind: "path", path: inspected.inspect.sshKey };
    },
    async destroy(lease): Promise<void> {
      const context = resolveLeaseContext(lease);
      // Fence the provider keepalive before teardown so an in-flight touch cannot reschedule.
      heartbeats.stop(context.id);
      await stopCrabboxLease({ ...context, runCommand });
    },
  };
}
