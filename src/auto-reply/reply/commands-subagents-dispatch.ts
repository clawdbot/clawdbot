// Dispatches subagent command actions after parsing the subcommand target.
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { HandleCommandsParams } from "./commands-types.js";

export {
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
} from "./commands-subagents/shared.js";

export type SubagentsCommandContext = {
  params: HandleCommandsParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};
