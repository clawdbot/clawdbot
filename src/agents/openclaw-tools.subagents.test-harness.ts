import { vi } from "vitest";
import { __testing as queueCleanupTesting } from "../auto-reply/reply/queue/cleanup.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { __testing as subagentAnnounceTesting } from "./subagent-announce.js";
import { __testing as subagentControlTesting } from "./subagent-control.js";

export type LoadedConfig = ReturnType<(typeof import("../config/config.js"))["getRuntimeConfig"]>;

export const callGatewayMock: MockFn = vi.fn();

const defaultConfig: LoadedConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

let configOverride: LoadedConfig = defaultConfig;

async function callGatewayForTest<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  return (await callGatewayMock(opts)) as T;
}

export function setSubagentsConfigOverride(next: LoadedConfig) {
  configOverride = next;
}

export function resetSubagentsConfigOverride() {
  configOverride = defaultConfig;
}

function applySharedSubagentTestDeps() {
  subagentControlTesting.setDepsForTest({
    callGateway: callGatewayForTest,
  });
  subagentAnnounceTesting.setDepsForTest({
    callGateway: callGatewayForTest,
    getRuntimeConfig: () => configOverride,
  });
  queueCleanupTesting.setDepsForTests({
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  });
}

applySharedSubagentTestDeps();

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayForTest,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});
