import type { SessionWorkAdmissionLease } from "../sessions/session-lifecycle-admission.js";
import {
  createCodeModeActivityOwner,
  discardCodeModeRunActivity,
  retainCodeModeRunActivityUntilSettlement,
  sampleCodeModeRunFinalQuiescence,
  type CodeModeActivityOwner,
} from "./code-mode-activity.js";
import { disposeCodeModeRunsByActivityOwner } from "./code-mode-state.js";
import type { RunAccountingAccumulator } from "./command/run-accounting.types.js";

type AgentCommandCodeModeLifecycle = {
  owner: CodeModeActivityOwner;
  settle: (admission: SessionWorkAdmissionLease | undefined) => void;
};

export function createAgentCommandCodeModeLifecycle(
  accounting: RunAccountingAccumulator | undefined,
): AgentCommandCodeModeLifecycle {
  const owner = createCodeModeActivityOwner();
  return {
    owner,
    settle(admission) {
      accounting?.observeCodeModeFinalQuiescence(sampleCodeModeRunFinalQuiescence(owner));
      disposeCodeModeRunsByActivityOwner(owner);
      if (sampleCodeModeRunFinalQuiescence(owner) !== "non_quiescent") {
        discardCodeModeRunActivity(owner);
        return;
      }
      if (!admission) {
        discardCodeModeRunActivity(owner);
        return;
      }
      const blocker = admission.createLifecycleBlocker("code_mode_non_quiescent");
      if (
        retainCodeModeRunActivityUntilSettlement(owner, () => {
          blocker.release();
          discardCodeModeRunActivity(owner);
        })
      ) {
        return;
      }
      blocker.release();
      discardCodeModeRunActivity(owner);
    },
  };
}
