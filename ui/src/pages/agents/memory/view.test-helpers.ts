import type { renderDreaming } from "./view.ts";

export const fullDreamingViewAccess: Parameters<typeof renderDreaming>[0]["access"] = {
  canOpenConfig: true,
  canBackfillDiary: true,
  canDedupeDreamDiary: true,
  canResetDiary: true,
  canResetGroundedShortTerm: true,
  canRepairDreamingArtifacts: true,
};
