import type { SystemAgentTurnRunner } from "./agent-turn.js";
import "./agent-turn.js";
import type { SystemAgentVerifiedInferenceDeps } from "./verified-inference.js";

type SystemAgentRunEmbeddedAgent = (
  params: Parameters<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>[0] & {
    systemAgentTool?: import("../agents/tools/system-agent-tool.js").SystemAgentToolOptions;
  },
) => ReturnType<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;

type SystemAgentRunCliAgent = (
  params: Parameters<typeof import("../agents/cli-runner.js").runCliAgent>[0] & {
    systemAgentTool?: import("../agents/tools/system-agent-tool.js").SystemAgentToolOptions;
  },
) => ReturnType<typeof import("../agents/cli-runner.js").runCliAgent>;

export type SystemAgentTurnDeps = SystemAgentVerifiedInferenceDeps & {
  runEmbeddedAgent?: SystemAgentRunEmbeddedAgent;
  runCliAgent?: SystemAgentRunCliAgent;
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
};

type SystemAgentTurnTestApi = {
  runSystemAgentTurnWithDeps(
    params: Parameters<SystemAgentTurnRunner>[0],
    deps?: SystemAgentTurnDeps,
  ): ReturnType<SystemAgentTurnRunner>;
};

function getTestApi(): SystemAgentTurnTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.systemAgentTurnTestApi")
  ] as SystemAgentTurnTestApi;
}

export function runSystemAgentTurnWithDeps(
  params: Parameters<SystemAgentTurnRunner>[0],
  deps: SystemAgentTurnDeps = {},
): ReturnType<SystemAgentTurnRunner> {
  return getTestApi().runSystemAgentTurnWithDeps(params, deps);
}
