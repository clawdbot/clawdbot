/** Public facade for the exec tool factory and default instance. */
import { createExecTool } from "./bash-tools.exec-run.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
export { createExecTool };

/** Default exec tool instance used by agent tool registries. */
export const execTool = createExecTool();
