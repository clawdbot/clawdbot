import { vi } from "vitest";
import { buildSubagentsSendContext } from "./commands-subagents.test-helpers.js";

export const subagentControlMocks = {
  sendControlledSubagentMessage: vi.fn(),
  steerControlledSubagentRun: vi.fn(),
};

vi.doMock("./commands-subagents-control.runtime.js", () => ({
  sendControlledSubagentMessage: subagentControlMocks.sendControlledSubagentMessage,
  steerControlledSubagentRun: subagentControlMocks.steerControlledSubagentRun,
}));

export function buildSubagentsDispatchContext(params: {
  handledPrefix: string;
  restTokens: string[];
}) {
  return buildSubagentsSendContext({
    handledPrefix: params.handledPrefix,
    restTokens: params.restTokens,
  });
}
