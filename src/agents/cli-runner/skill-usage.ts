import { recordExplicitSkillSelectionsForRun } from "../skill-selection-usage.js";
import { settlePreparedCliRun } from "./cli-run-settlement.js";

/** Records exact explicit selections for the lifetime owned by CLI settlement. */
export async function settlePreparedCliRunWithSkillUsage(
  params: Parameters<typeof settlePreparedCliRun>[0],
): ReturnType<typeof settlePreparedCliRun> {
  const { context } = params;
  recordExplicitSkillSelectionsForRun({
    operationalRunInstance: context.params.admittedRunContext.operationalRunInstance,
    selections: context.params.explicitSkillSelections,
    skillsSnapshot: context.params.skillsSnapshot,
  });
  return await settlePreparedCliRun(params);
}
