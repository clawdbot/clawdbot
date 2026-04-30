import { vi } from "vitest";
import { agentCommand } from "./test-helpers.runtime-state.js";

export type AgentCommandCall = Record<string, unknown>;

function agentCommandCalls(): Array<[AgentCommandCall]> {
  return vi.mocked(agentCommand).mock.calls as unknown as Array<[AgentCommandCall]>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForAgentCommandCall(runId: string): Promise<AgentCommandCall> {
  for (let elapsed = 0; elapsed <= 2_000; elapsed += 5) {
    const call = agentCommandCalls()
      .map((entry) => entry[0])
      .find((entry) => entry.runId === runId);
    if (call) {
      return call;
    }
    await sleep(5);
  }
  throw new Error(`expected agentCommand to be called for ${runId}`);
}

export async function readAgentCommandCall(
  params: { runId?: string; fromEnd?: number } = {},
): Promise<AgentCommandCall> {
  if (params.runId) {
    return await waitForAgentCommandCall(params.runId);
  }
  return agentCommandCalls().at(-(params.fromEnd ?? 1))?.[0] ?? {};
}
