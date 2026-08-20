// QA Lab Matrix setup prepares transport state for the shared flow host.
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixQaProvisionResult, MatrixQaRoomObserver } from "../substrate/client.js";
import { buildMatrixQaConfig, type MatrixQaConfigOverrides } from "../substrate/config.js";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import type { startMatrixQaHarness } from "../substrate/harness.runtime.js";
import { runMatrixQaCanary } from "./scenario-runtime-room.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaCanaryArtifact } from "./scenario-types.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];
type MatrixQaGateway = FlowPreparationInput["gateway"];
type MatrixQaHarness = Awaited<ReturnType<typeof startMatrixQaHarness>>;

const MATRIX_QA_PREPARATION_TIMEOUT_MS = 60_000;
const MATRIX_QA_PATCH_BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MATRIX_QA_PATCH_UNCHANGED = Symbol("matrix-qa-patch-unchanged");

type MatrixQaScenarioEnvironmentParams = {
  accountId: string;
  harness: MatrixQaHarness;
  onTransportInterruptionStateChange?: (active: boolean) => void;
  observedEvents: MatrixQaObservedEvent[];
  provisioning: MatrixQaProvisionResult;
};

type MatrixQaConfigPatchResult = {
  hash?: string;
  noop?: boolean;
  sentinel?: {
    payload?: {
      stats?: {
        requiresRestart?: boolean;
      };
    };
  };
};

type MatrixQaConfigApplyStatus = {
  appliedConfigHash?: string | null;
  configRevisionHash?: string;
  hash?: string;
};

function resetMatrixQaScenarioObserverState(params: {
  syncState: MatrixQaScenarioContext["syncState"];
  syncStreams: NonNullable<MatrixQaScenarioContext["syncStreams"]>;
}) {
  delete params.syncState.driver;
  delete params.syncState.observer;
  delete params.syncStreams.driver;
  delete params.syncStreams.observer;
}

function readMatrixConfigOverrides(
  config: Record<string, unknown>,
): MatrixQaConfigOverrides | undefined {
  const value = config.matrixConfigOverrides;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MatrixQaConfigOverrides)
    : undefined;
}

function arrayPreservesBaseEntries(base: unknown[], merged: unknown[]): boolean {
  const unmatchedMerged = [...merged];
  for (const baseEntry of base) {
    const matchIndex = unmatchedMerged.findIndex((mergedEntry) =>
      isDeepStrictEqual(mergedEntry, baseEntry),
    );
    if (matchIndex === -1) {
      return false;
    }
    unmatchedMerged.splice(matchIndex, 1);
  }
  return true;
}

function createMatrixQaConfigPatch(
  current: OpenClawConfig,
  target: OpenClawConfig,
  accountId: string,
) {
  const accountPath = `channels.matrix.accounts.${accountId}`;
  const replacePaths = new Set<string>();
  const isReplacePath = (path: string) =>
    /^(?:account\.(?:autoJoinAllowlist|dm\.allowFrom|execApprovals\.(?:agentFilter|approvers|sessionFilter)|groupAllowFrom|groups\..+\.tools\.(?:allow|deny))|messages\.groupChat\.mentionPatterns|tools\.media\.(?:models|audio\.scope\.rules))$/u.test(
      path.startsWith(accountPath) ? `account${path.slice(accountPath.length)}` : path,
    );
  const diff = (before: unknown, after: unknown, path: string): unknown => {
    if (isDeepStrictEqual(before, after)) {
      return MATRIX_QA_PATCH_UNCHANGED;
    }
    if (!isRecord(after)) {
      // Gateway validates exact array intent below parent tombstones, so walk
      // removed objects while admitting only Matrix QA-owned array leaves.
      if (after === null && isRecord(before)) {
        for (const key of Object.keys(before)) {
          if (MATRIX_QA_PATCH_BLOCKED_KEYS.has(key)) {
            continue;
          }
          diff(before[key], null, path ? `${path}.${key}` : key);
        }
      }
      if (
        Array.isArray(before) &&
        (!Array.isArray(after) || !arrayPreservesBaseEntries(before, after)) &&
        isReplacePath(path)
      ) {
        replacePaths.add(path);
      }
      return structuredClone(after);
    }
    const source = isRecord(before) ? before : {};
    const patch: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(source), ...Object.keys(after)])) {
      if (MATRIX_QA_PATCH_BLOCKED_KEYS.has(key)) {
        continue;
      }
      const childPath = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(after, key)) {
        patch[key] = null;
        diff(source[key], null, childPath);
        continue;
      }
      const value = diff(source[key], after[key], childPath);
      if (value !== MATRIX_QA_PATCH_UNCHANGED) {
        patch[key] = value;
      }
    }
    return patch;
  };
  const patch = diff(current, target, "");
  return {
    patch: patch === MATRIX_QA_PATCH_UNCHANGED ? {} : (patch as Record<string, unknown>),
    replacePaths: [...replacePaths].toSorted(),
  };
}

function isStaleConfigPatchError(error: unknown) {
  return formatErrorMessage(error).toLowerCase().includes("config changed since last load");
}

async function patchGatewayConfig(params: {
  deadlineMs: number;
  gateway: FlowPreparationInput["gateway"];
  patch: Record<string, unknown>;
  replacePaths?: string[];
  restartDelayMs?: number;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = (await params.gateway.call(
      "config.get",
      {},
      {
        deadlineMs: params.deadlineMs,
        timeoutMs: 60_000,
      },
    )) as {
      hash?: string;
    };
    if (!snapshot.hash) {
      throw new Error("Matrix QA config patch requires config.get hash");
    }
    try {
      const result = (await params.gateway.call(
        "config.patch",
        {
          raw: JSON.stringify(params.patch, null, 2),
          baseHash: snapshot.hash,
          ...(params.replacePaths?.length ? { replacePaths: params.replacePaths } : {}),
          restartDelayMs: params.restartDelayMs ?? 0,
        },
        { deadlineMs: params.deadlineMs, timeoutMs: 60_000 },
      )) as MatrixQaConfigPatchResult;
      return result.noop === true ? { ...result, hash: snapshot.hash } : result;
    } catch (error) {
      if (attempt === 0 && isStaleConfigPatchError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Matrix QA config patch exhausted retries");
}

async function waitForMatrixAccountReady(params: {
  afterStartAt?: number;
  accountId: string;
  deadline: number;
  gateway: FlowPreparationInput["gateway"];
}) {
  const deadline = params.deadline;
  let lastAccounts: unknown;
  let remainingMs: number;
  while ((remainingMs = deadline - Date.now()) > 0) {
    try {
      const accounts = await readMatrixAccountStatuses(
        params.gateway,
        remainingMs,
        params.deadline,
      );
      lastAccounts = accounts;
      const account = accounts.find((entry) => entry.accountId === params.accountId);
      if (
        account?.running === true &&
        account.connected === true &&
        account.restartPending !== true &&
        account.healthState !== "degraded" &&
        (params.afterStartAt === undefined ||
          (typeof account.lastStartAt === "number" && account.lastStartAt > params.afterStartAt))
      ) {
        return;
      }
    } catch {
      // Retry until the scenario-specific readiness deadline.
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `matrix account "${params.accountId}" did not become ready; last accounts: ${JSON.stringify(lastAccounts ?? [])}`,
  );
}

async function waitForGatewayConfigApplied(params: {
  deadline: number;
  expectedHash: string;
  gateway: FlowPreparationInput["gateway"];
}) {
  const deadline = params.deadline;
  let lastStatus: MatrixQaConfigApplyStatus | undefined;
  let remainingMs: number;
  while ((remainingMs = deadline - Date.now()) > 0) {
    try {
      const status = (await params.gateway.call(
        "config.get",
        {},
        { deadlineMs: params.deadline, timeoutMs: Math.min(5_000, remainingMs) },
      )) as MatrixQaConfigApplyStatus;
      lastStatus = status;
      if (
        status.hash === params.expectedHash &&
        typeof status.configRevisionHash === "string" &&
        status.configRevisionHash === status.appliedConfigHash
      ) {
        return;
      }
    } catch {
      // A restart may temporarily disconnect the control client; retry until the deadline.
    }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `Matrix QA config was not applied by the active Gateway; last status: ${JSON.stringify(lastStatus ?? {})}`,
  );
}

type MatrixAccountStatus = {
  accountId?: string;
  connected?: boolean;
  healthState?: string;
  lastStartAt?: number;
  restartPending?: boolean;
  running?: boolean;
};

async function readMatrixAccountStatuses(
  gateway: MatrixQaGateway,
  timeoutMs = 5_000,
  deadlineMs?: number,
) {
  const payload = (await gateway.call(
    "channels.status",
    { probe: false, timeoutMs: Math.min(2_000, timeoutMs) },
    {
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      timeoutMs: Math.min(5_000, timeoutMs),
    },
  )) as { channelAccounts?: Record<string, MatrixAccountStatus[]> };
  return payload.channelAccounts?.matrix ?? [];
}

export function createMatrixQaScenarioEnvironment(params: MatrixQaScenarioEnvironmentParams) {
  const syncState = {};
  const syncStreams: Partial<Record<"driver" | "observer", MatrixQaRoomObserver>> = {};
  let canary: MatrixQaCanaryArtifact | undefined;
  let baselineConfig: OpenClawConfig | undefined;

  const prepareFlow = async (input: FlowPreparationInput) => {
    const preparationDeadline =
      Date.now() + Math.max(input.timeoutMs, MATRIX_QA_PREPARATION_TIMEOUT_MS);
    const configOverrides = readMatrixConfigOverrides(input.config);
    const configSnapshot = (await input.gateway.call(
      "config.get",
      {},
      {
        deadlineMs: preparationDeadline,
        timeoutMs: 60_000,
      },
    )) as {
      config?: OpenClawConfig;
    };
    if (!configSnapshot.config) {
      throw new Error("Matrix QA scenario requires config.get config");
    }
    baselineConfig ??= structuredClone(configSnapshot.config);
    const gatewayConfig = buildMatrixQaConfig(baselineConfig, {
      currentConfig: configSnapshot.config,
      driverAccessToken: params.provisioning.driver.accessToken,
      driverUserId: params.provisioning.driver.userId,
      homeserver: params.harness.baseUrl,
      observerAccessToken: params.provisioning.observer.accessToken,
      observerUserId: params.provisioning.observer.userId,
      overrides: configOverrides,
      sutAccessToken: params.provisioning.sut.accessToken,
      sutAccountId: params.accountId,
      sutDeviceId: params.provisioning.sut.deviceId,
      sutUserId: params.provisioning.sut.userId,
      topology: params.provisioning.topology,
    });
    const gatewayPatch = createMatrixQaConfigPatch(
      configSnapshot.config,
      gatewayConfig,
      params.accountId,
    );
    const matrixConfigChanged = !isDeepStrictEqual(
      configSnapshot.config.channels?.matrix,
      gatewayConfig.channels?.matrix,
    );
    const patchStartedAt = Date.now();
    const accountStartAtBeforePatch = (
      await readMatrixAccountStatuses(input.gateway, 5_000, preparationDeadline).catch(() => [])
    ).find((account) => account.accountId === params.accountId)?.lastStartAt;
    const patchResult = await patchGatewayConfig({
      deadlineMs: preparationDeadline,
      gateway: input.gateway,
      patch: gatewayPatch.patch,
      replacePaths: gatewayPatch.replacePaths,
    });
    if (!patchResult.hash) {
      throw new Error("Matrix QA config patch returned no persisted hash");
    }
    // A changed or no-op write can observe persisted config before an earlier
    // reload installs that revision. Do not run against the previous snapshot.
    await waitForGatewayConfigApplied({
      deadline: preparationDeadline,
      expectedHash: patchResult.hash,
      gateway: input.gateway,
    });
    await waitForMatrixAccountReady({
      // Config writes acknowledge persisted state before a deferred channel
      // reload completes. Require the changed Matrix account to actually restart
      // so a later config patch cannot supersede this scenario's live runtime.
      afterStartAt:
        matrixConfigChanged && patchResult.noop !== true
          ? (accountStartAtBeforePatch ?? patchStartedAt - 1)
          : undefined,
      accountId: params.accountId,
      deadline: preparationDeadline,
      gateway: input.gateway,
    });
    // Scenario actors must prime after each config/reload boundary. Reusing an
    // observer across channel restarts can retain an in-flight timeline cursor
    // and consume the next scenario's first preview before its predicate exists.
    resetMatrixQaScenarioObserverState({ syncState, syncStreams });

    const scenarioContext = {
      baseUrl: params.harness.baseUrl,
      canary,
      driverAccessToken: params.provisioning.driver.accessToken,
      driverDeviceId: params.provisioning.driver.deviceId,
      driverPassword: params.provisioning.driver.password,
      driverUserId: params.provisioning.driver.userId,
      faultProxyObserver: params.harness.recording,
      faultProxyTargetBaseUrl: params.harness.upstreamBaseUrl,
      installFaultRule: (rule) => params.harness.recording.installFaultRule(rule),
      observedEvents: params.observedEvents,
      observerAccessToken: params.provisioning.observer.accessToken,
      observerDeviceId: params.provisioning.observer.deviceId,
      observerPassword: params.provisioning.observer.password,
      observerUserId: params.provisioning.observer.userId,
      gatewayRuntimeEnv: input.gateway.runtimeEnv,
      gatewayStateDir: input.gateway.runtimeEnv.OPENCLAW_STATE_DIR,
      gatewayWorkspaceDir: input.gateway.workspaceDir,
      gatewayCall: async (
        method: string,
        callParams?: Record<string, unknown>,
        opts?: { expectFinal?: boolean; timeoutMs?: number },
      ) => await input.gateway.call(method, callParams ?? {}, opts),
      outputDir: input.outputDir,
      registrationToken: params.harness.registrationToken,
      restartGateway: async () => {
        const restart = input.gateway.restartAfterStateMutation;
        if (!restart) {
          throw new Error("Matrix restart scenario requires Gateway restart support");
        }
        await restart(async () => undefined);
        await waitForMatrixAccountReady({
          accountId: params.accountId,
          deadline: Date.now() + input.timeoutMs,
          gateway: input.gateway,
        });
      },
      restartGatewayAfterStateMutation: async (
        mutateState: (context: { stateDir: string }) => Promise<void>,
        opts?: { timeoutMs?: number; waitAccountId?: string },
      ) => {
        const restart = input.gateway.restartAfterStateMutation;
        if (!restart) {
          throw new Error("Matrix persisted-state scenario requires Gateway restart support");
        }
        const waitAccountId = opts?.waitAccountId ?? params.accountId;
        const beforeRestartAt = (
          await readMatrixAccountStatuses(input.gateway).catch(() => [])
        ).find((account) => account.accountId === waitAccountId)?.lastStartAt;
        const restartStartedAt = Date.now();
        await restart(async ({ stateDir }) => await mutateState({ stateDir }));
        await waitForMatrixAccountReady({
          afterStartAt: beforeRestartAt ?? restartStartedAt,
          accountId: waitAccountId,
          deadline: Date.now() + (opts?.timeoutMs ?? input.timeoutMs),
          gateway: input.gateway,
        });
      },
      restartGatewayWithQueuedMessage: async (queueMessage: () => Promise<void>) => {
        const restart = input.gateway.restartAfterStateMutation;
        if (!restart) {
          throw new Error("Matrix catchup scenario requires Gateway restart support");
        }
        await restart(async () => await queueMessage());
        await waitForMatrixAccountReady({
          accountId: params.accountId,
          deadline: Date.now() + input.timeoutMs,
          gateway: input.gateway,
        });
      },
      interruptTransport: async () => {
        params.onTransportInterruptionStateChange?.(true);
        try {
          await params.harness.restartService();
          await waitForMatrixAccountReady({
            accountId: params.accountId,
            deadline: Date.now() + Math.max(input.timeoutMs, 90_000),
            gateway: input.gateway,
          });
        } finally {
          params.onTransportInterruptionStateChange?.(false);
        }
      },
      roomId: params.provisioning.roomId,
      sutAccountId: params.accountId,
      sutAccessToken: params.provisioning.sut.accessToken,
      sutDeviceId: params.provisioning.sut.deviceId,
      sutPassword: params.provisioning.sut.password,
      syncState,
      syncStreams,
      sutUserId: params.provisioning.sut.userId,
      timeoutMs: input.timeoutMs,
      topology: params.provisioning.topology,
      patchGatewayConfig: async (
        patch: Record<string, unknown>,
        opts?: { replacePaths?: string[]; restartDelayMs?: number },
      ) => {
        await patchGatewayConfig({
          deadlineMs: preparationDeadline,
          gateway: input.gateway,
          patch,
          replacePaths: opts?.replacePaths,
          restartDelayMs: opts?.restartDelayMs,
        });
      },
      readGatewayAccountStartAt: async (accountId: string) =>
        (await readMatrixAccountStatuses(input.gateway)).find(
          (account) => account.accountId === accountId,
        )?.lastStartAt,
      waitGatewayAccountReady: async (
        accountId: string,
        opts?: { afterStartAt?: number; timeoutMs?: number },
      ) =>
        await waitForMatrixAccountReady({
          afterStartAt: opts?.afterStartAt,
          accountId,
          deadline: Date.now() + (opts?.timeoutMs ?? input.timeoutMs),
          gateway: input.gateway,
        }),
    } satisfies MatrixQaScenarioContext;
    if (input.config.matrixRequireCanary === true && !canary) {
      canary = await runMatrixQaCanary({
        ...scenarioContext,
        // The scenario timeout can intentionally be a short no-reply window.
        // A live model round trip needs its own bounded preparation budget.
        timeoutMs: Math.max(input.timeoutMs, MATRIX_QA_PREPARATION_TIMEOUT_MS),
      });
    }
    scenarioContext.canary = canary;
    return { scenarioContext };
  };

  return { prepareFlow };
}
