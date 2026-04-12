import { buildSubagentsSendContext } from "./commands-subagents.test-helpers.js";

export function buildSubagentsDispatchContext(params: {
  handledPrefix: string;
  restTokens: string[];
}) {
  return buildSubagentsSendContext({
    handledPrefix: params.handledPrefix,
    restTokens: params.restTokens,
  });
}
