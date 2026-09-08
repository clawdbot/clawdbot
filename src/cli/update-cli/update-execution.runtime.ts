// Planning stays light; load this whole surface before replacing the installed package.
// Config writes are lazy for ordinary CLI startup, but update finalization can first write
// after a rebuild removes the old hashed chunk. Preload that closure before mutation.
import "../../config/io.write.js";

export { executeMutableUpdate } from "./update-command-execution.js";
export { finishAlreadyCurrentUpdate } from "./update-command-noop.js";
export {
  continueMigratedUpdateInFreshProcess,
  inspectActivatedUpdateState,
} from "./update-command-migrated.js";
export { finishUpdate } from "./update-command-post-update.js";
export { resumePostCoreUpdate } from "./update-command-resume.js";
