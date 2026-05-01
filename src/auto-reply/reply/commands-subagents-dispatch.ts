import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { HandleCommandsParams } from "./commands-types.js";

export {
  COMMAND,
  COMMAND_KILL,
  COMMAND_STEER,
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
} from "./commands-subagents/shared.js";

export type SubagentsCommandContext = {
  params: HandleCommandsParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};
