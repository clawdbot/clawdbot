// QA Lab Matrix setup prepares transport state for the shared flow host.
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { MatrixQaProvisionResult } from "../substrate/client.js";
import type { MatrixQaRoomObserver } from "../substrate/client.js";
import { buildMatrixQaConfig, type MatrixQaConfigOverrides } from "../substrate/config.js";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import type { startMatrixQaHarness } from "../substrate/harness.runtime.js";
import { runMatrixQaCanary } from "./scenario-runtime-room.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaCanaryArtifact } from "./scenario-types.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];
type MatrixQaHarness = Awaited<ReturnType<typeof startMatrixQaHarness>>;

type MatrixQaScenarioEnvironmentParams = {
  accountId: string;
  harness: MatrixQaHarness;
  observedEvents: MatrixQaObservedEvent[];
  provisioning: MatrixQaProvisionResult;
};

function readMatrixConfigOverrides(
  config: Record<string, unknown>,
): MatrixQaConfigOverrides | undefined {
  const value = config.matrixConfigOverrides;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MatrixQaConfigOverrides)
    : undefined;
}

function isStaleConfigPatchError(error: unknown) {
  return formatErrorMessage(error).toLowerCase().includes("config changed since last load");
}

async function patchGatewayConfig(params: {
  gateway: FlowPreparationInput["gateway"];
  patch: Record<string, unknown>;
  replacePaths?: string[];
  restartDelayMs?: number;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = (await params.gateway.call("config.get", {}, { timeoutMs: 60_000 })) as {
      hash?: string;
    };
    if (!snapshot.hash) {
      throw new Error("Matrix QA config patch requires config.get hash");
    }
    try {
      return (await params.gateway.call(
        "config.patch",
        {
          raw: JSON.stringify(params.patch, null, 2),
          baseHash: snapshot.hash,
          ...(params.replacePaths?.length ? { replacePaths: params.replacePaths } : {}),
          restartDelayMs: params.restartDelayMs ?? 0,
        },
        { timeoutMs: 60_000 },
      )) as { noop?: boolean };
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
  gateway: FlowPreparationInput["gateway"];
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastAccounts: unknown;
  while (Date.now() < deadline) {
    try {
      const accounts = await readMatrixAccountStatuses(params.gateway);
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
    await sleep(500);
  }
  throw new Error(
    `matrix account "${params.accountId}" did not become ready; last accounts: ${JSON.stringify(lastAccounts ?? [])}`,
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

async function readMatrixAccountStatuses(gateway: FlowPreparationInput["gateway"]) {
  const payload = (await gateway.call(
    "channels.status",
    { probe: false, timeoutMs: 2_000 },
    { timeoutMs: 5_000 },
  )) as { channelAccounts?: Record<string, MatrixAccountStatus[]> };
  return payload.channelAccounts?.matrix ?? [];
}

export function createMatrixQaScenarioEnvironment(params: MatrixQaScenarioEnvironmentParams) {
  const syncState = {};
  const syncStreams: Partial<Record<"driver" | "observer", MatrixQaRoomObserver>> = {};
  let canary: MatrixQaCanaryArtifact | undefined;

  const prepareFlow = async (input: FlowPreparationInput) => {
    const configOverrides = readMatrixConfigOverrides(input.config);
    const configSnapshot = (await input.gateway.call("config.get", {}, { timeoutMs: 60_000 })) as {
      config?: OpenClawConfig;
    };
    if (!configSnapshot.config) {
      throw new Error("Matrix QA scenario requires config.get config");
    }
    const gatewayConfig = buildMatrixQaConfig(configSnapshot.config, {
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
    const patchResult = await patchGatewayConfig({
      gateway: input.gateway,
      patch: gatewayConfig as Record<string, unknown>,
      replacePaths: ["channels.matrix", "messages", "agents.defaults", "tools"],
    });
    if (patchResult.noop !== true) {
      await input.waitForConfigRestartSettle({
        restartDelayMs: 0,
        timeoutMs: input.timeoutMs,
      });
    }
    await waitForMatrixAccountReady({
      accountId: params.accountId,
      gateway: input.gateway,
      timeoutMs: input.timeoutMs,
    });

    const scenarioContext = {
      baseUrl: params.harness.baseUrl,
      canary,
      driverAccessToken: params.provisioning.driver.accessToken,
      driverDeviceId: params.provisioning.driver.deviceId,
      driverPassword: params.provisioning.driver.password,
      driverUserId: params.provisioning.driver.userId,
      faultProxyObserver: params.harness.recording,
      faultProxyTargetBaseUrl: params.harness.upstreamBaseUrl,
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
          gateway: input.gateway,
          timeoutMs: input.timeoutMs,
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
        await restart(async ({ stateDir }) => await mutateState({ stateDir }));
        await waitForMatrixAccountReady({
          accountId: opts?.waitAccountId ?? params.accountId,
          gateway: input.gateway,
          timeoutMs: opts?.timeoutMs ?? input.timeoutMs,
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
          gateway: input.gateway,
          timeoutMs: input.timeoutMs,
        });
      },
      interruptTransport: async () => {
        await params.harness.restartService();
        await waitForMatrixAccountReady({
          accountId: params.accountId,
          gateway: input.gateway,
          timeoutMs: Math.max(input.timeoutMs, 90_000),
        });
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
          gateway: input.gateway,
          timeoutMs: opts?.timeoutMs ?? input.timeoutMs,
        }),
    } satisfies MatrixQaScenarioContext;
    if (input.config.matrixRequireCanary === true && !canary) {
      canary = await runMatrixQaCanary(scenarioContext);
    }
    scenarioContext.canary = canary;
    return { scenarioContext };
  };

  return { prepareFlow };
}
