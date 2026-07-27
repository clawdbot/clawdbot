/**
 * Lazy boundary for doctor memory-core repair helpers.
 *
 * Doctor tests mock this file so the gateway method does not import bundled
 * memory-core runtime code until a repair action actually needs it.
 */
export {
  dedupeDreamDiaryEntries,
  loadShortTermPromotionDreamingStats,
  previewGroundedRemMarkdown,
  previewRemHarness,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  repairDreamingArtifacts,
  writeBackfillDiaryEntries,
} from "../../plugin-sdk/memory-core-bundled-runtime.js";
