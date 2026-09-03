import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSkillProposalRecord as readSkillProposalRecordImpl } from "../../skills/workshop/store.js";

const workshopConfig: OpenClawConfig = {};

export function readSkillWorkshopTestProposalRecord(
  proposalId: string,
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return readSkillProposalRecordImpl(
    proposalId,
    { config: workshopConfig, ...options },
    {},
    { config: workshopConfig },
  );
}
