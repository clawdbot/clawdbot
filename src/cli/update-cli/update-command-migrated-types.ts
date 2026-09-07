import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import type { UpdateRequesterAuthority } from "../../infra/update-requester-authority.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import type { UpdateRecoveryHandoff } from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateCommandChildGrant } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
export type MigratedUpdateFinalizationInput = {
  params: Omit<FinishUpdateParams, "packageTransaction" | "preManagedServiceStop" | "opts"> & {
    opts: Omit<FinishUpdateParams["opts"], "run" | "recovery"> & {
      run?: Omit<
        NonNullable<FinishUpdateParams["opts"]["run"]>,
        "requesterAuthority" | "executorFence"
      > & {
        requesterAuthority?: Pick<UpdateRequesterAuthority, "requester">;
      };
    };
    preManagedServiceStop?: Omit<
      NonNullable<FinishUpdateParams["preManagedServiceStop"]>,
      "windowsTaskAutoStartRecovery"
    >;
  };
  executor?: UpdateCommandChildGrant;
  recoveryHandoff?: UpdateRecoveryHandoff;
  bufferedSteps: UpdateRunStep[];
  windowsTaskAutoStartSuspended?: true;
  resultPath: string;
};

export type MigratedUpdateFinalizationResult = {
  result: UpdateRunResult;
  exitCode: number;
  terminalRunId: string;
  executorDelegation?: "pid-start-v1";
  automaticTriage?: TriageFailureContext;
};
