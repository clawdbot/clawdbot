// Public process helpers for plugins that spawn or probe local commands.

export * from "../process/exec.js";
export { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
export type { OomScoreAdjustedSpawn, OomWrapOptions } from "../process/linux-oom-score.js";
