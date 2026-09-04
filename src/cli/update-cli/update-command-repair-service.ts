import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateCommandOptions } from "./shared.js";
import { runUpdateCommandRepair } from "./update-command-repair.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import { assertGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";
import {
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

export async function repairUpdateService(params: {
  result: UpdateRunResult;
  root: string;
  env: NodeJS.ProcessEnv;
  opts: UpdateCommandOptions;
  gatewayPort: number;
  nodeRunner?: string;
  timeoutMs: number;
  invocationCwd?: string;
  expectedService: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict">;
  recoveryStop?: PreManagedServiceStop;
  onVerified?: (verifiedAtMs: number) => void;
}): Promise<UpdateRunResult> {
  const root = params.result.root ?? params.root;
  let turnPendingValidation = false;
  let pinnedService: typeof params.expectedService | undefined;
  const inspectOwner = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: params.env,
      requireEffective: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.timeoutMs,
    });
    const verdict = await revalidateManagedGatewayServiceAfterUpdate({
      state,
      root,
      preManagedServiceStop: pinnedService ?? params.expectedService,
    });
    signal.throwIfAborted();
    if (verdict.kind !== "owned" && verdict.kind !== "unresolved") {
      throw new Error("Gateway service ownership could not be verified for update repair.");
    }
    // A refreshed definition is observed once before inference. Later turns
    // must retain this exact launcher, rather than inherit refresh authority.
    pinnedService = {
      serviceEnv: state.env,
      serviceUpdateVerdict:
        verdict.kind === "owned" ? { ...verdict, refreshDefinition: false } : verdict,
    };
    return state;
  };
  const repair = await runUpdateCommandRepair({
    root,
    env: params.env,
    run: params.opts.run,
    result: params.result,
    phase: "verifying",
    nodeRunner: params.nodeRunner,
    onEvent: (event) => {
      if (event.type === "turn-started") {
        turnPendingValidation = true;
      }
    },
    validate: async (signal, assertCurrent) => {
      if (!pinnedService) {
        await inspectOwner(signal);
      }
      const verify = () =>
        verifyUpdatedGateway({
          result: params.result,
          opts: params.opts,
          serviceEnv: params.env,
          gatewayPort: params.gatewayPort,
          nodeRunner: params.nodeRunner,
          expectedVersion: params.result.after?.version ?? undefined,
          expectedBuildId: params.result.after?.buildId ?? undefined,
          requireRunningService: true,
          signal,
          onVerified: params.onVerified,
        });
      let validation = await verify();
      assertCurrent();
      // Initial diagnostics never restart. After a drained turn, the captured
      // service owner gets one restart; the independent oracle decides success.
      if (turnPendingValidation) {
        turnPendingValidation = false;
        if (!validation.ok) {
          const state = await inspectOwner(signal);
          assertCurrent();
          await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
            params.recoveryStop,
            true,
            createWindowsTaskAutoStartGuard({
              root,
              before: pinnedService ?? params.expectedService,
              timeoutMs: params.timeoutMs,
            }),
            assertCurrent,
          );
          signal.throwIfAborted();
          try {
            await runUpdatedInstallGatewayCommand(
              {
                result: params.result,
                opts: params.opts,
                invocationEnv: params.env,
                serviceEnv: state.env,
                nodeRunner: params.nodeRunner,
                timeoutMs: params.timeoutMs,
                invocationCwd: params.invocationCwd,
                signal,
                assertCurrent,
              },
              "restart",
              true,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (params.opts.run) {
              recordUpdateRunStep(
                params.opts.run.runId,
                {
                  step: "repair restart",
                  status: "failed",
                  endedAtMs: Date.now(),
                  detail: formatErrorMessage(error),
                },
                { env: params.opts.run.env },
              );
            }
          }

          signal.throwIfAborted();
          validation = await verify();
          assertCurrent();
        }
      }
      return validation;
    },
  });
  return repair.status === "repaired"
    ? { ...params.result, status: "ok", reason: undefined, recovery: undefined }
    : params.result;
}
