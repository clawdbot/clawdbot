// Tests OpenClaw execution environment construction.
import { describe, expect, it } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  canonicalizeAiAgentEnvOverrides,
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawExecEnv,
  OPENCLAW_CLI_ENV_VAR,
  resolveAiAgentEnvPlan,
  type AiAgentEnvPlan,
} from "./openclaw-exec-env.js";

const OPENCLAW_CLI_ENV_VALUE = "1";
const AI_AGENT_ENV_VALUE = "openclaw";

describe("markOpenClawExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", OPENCLAW_CLI: "0" };
    const marked = markOpenClawExecEnv(env);

    expect(marked).toEqual({
      AI_AGENT: AI_AGENT_ENV_VALUE,
      PATH: "/usr/bin",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.OPENCLAW_CLI).toBe("0");
  });

  it.each([
    {
      name: "preserves an explicit agent marker",
      value: " wrapper ",
      expected: " wrapper ",
    },
    { name: "defaults a blank agent marker", value: "   ", expected: AI_AGENT_ENV_VALUE },
  ])("$name", ({ value, expected }) => {
    expect(markOpenClawExecEnv({ AI_AGENT: value }).AI_AGENT).toBe(expected);
  });

  it.each([
    { value: " wrapper ", expected: " wrapper " },
    { value: "   ", expected: AI_AGENT_ENV_VALUE },
  ])("canonicalizes a Windows marker with value %j", ({ value, expected }) => {
    expect(markOpenClawExecEnv({ ai_agent: value }, "win32")).toEqual({
      AI_AGENT: expected,
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
  });
});

describe("canonicalizeAiAgentEnvOverrides", () => {
  it.each([
    { value: "wrapper", expected: "wrapper" },
    { value: "   ", expected: AI_AGENT_ENV_VALUE },
  ])("collapses a Windows marker alias with value %j", ({ value, expected }) => {
    expect(canonicalizeAiAgentEnvOverrides({ ai_agent: value, SAFE_KEY: "ok" }, "win32")).toEqual({
      AI_AGENT: expected,
      SAFE_KEY: "ok",
    });
  });

  it("defaults a blank POSIX marker", () => {
    expect(canonicalizeAiAgentEnvOverrides({ AI_AGENT: "   ", SAFE_KEY: "ok" }, "linux")).toEqual({
      AI_AGENT: AI_AGENT_ENV_VALUE,
      SAFE_KEY: "ok",
    });
  });

  it.each(["linux", "win32"] as const)(
    "does not add a marker when %s overrides do not contain one",
    (platform) => {
      expect(canonicalizeAiAgentEnvOverrides({ SAFE_KEY: "ok" }, platform)).toEqual({
        SAFE_KEY: "ok",
      });
    },
  );
});

describe("resolveAiAgentEnvPlan", () => {
  const plan = (overrides: Partial<AiAgentEnvPlan>): AiAgentEnvPlan => ({
    baseEnv: {},
    configuredEnv: {},
    overrideEnv: {},
    clearEnv: [],
    preserveEnv: [],
    forceClearBeforeOverrides: false,
    ...overrides,
  });

  it.each([
    ["omits the inherited default", "linux", plan({ baseEnv: { AI_AGENT: "openclaw" } }), {}],
    [
      "forwards a POSIX wrapper",
      "linux",
      plan({ configuredEnv: { AI_AGENT: "wrapper" } }),
      { value: "wrapper" },
    ],
    [
      "forwards an explicit reset",
      "linux",
      plan({ configuredEnv: { AI_AGENT: "   " } }),
      { value: "openclaw" },
    ],
    [
      "ignores a lowercase POSIX alias",
      "linux",
      plan({ configuredEnv: { ai_agent: "wrapper" } }),
      {},
    ],
    [
      "canonicalizes a Windows alias",
      "win32",
      plan({ configuredEnv: { ai_agent: "wrapper" } }),
      { value: "wrapper" },
    ],
    [
      "canonicalizes a Windows clear",
      "win32",
      plan({ baseEnv: { AI_AGENT: "wrapper" }, clearEnv: ["ai_agent"] }),
      { clear: true },
    ],
    [
      "keeps an explicit wrapper over a clear",
      "win32",
      plan({ configuredEnv: { ai_agent: "wrapper" }, clearEnv: ["ai_agent"] }),
      { value: "wrapper", clear: true },
    ],
  ] as const)("%s", (_name, platform, input, expected) => {
    expect(resolveAiAgentEnvPlan(input, platform)).toEqual({ clear: false, ...expected });
  });
});

describe("ensureOpenClawExecMarkerOnProcess", () => {
  it.each([
    {
      name: "mutates and returns the provided process env",
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      expectedAgent: AI_AGENT_ENV_VALUE,
    },
    {
      name: "overwrites the OpenClaw marker and preserves an explicit agent marker",
      env: {
        PATH: "/usr/bin",
        [OPENCLAW_CLI_ENV_VAR]: "0",
        AI_AGENT: "wrapper",
      } as NodeJS.ProcessEnv,
      expectedAgent: "wrapper",
    },
  ])("$name", ({ env, expectedAgent }) => {
    expect(ensureOpenClawExecMarkerOnProcess(env)).toBe(env);
    expect(env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(env.AI_AGENT).toBe(expectedAgent);
  });

  it("canonicalizes a mixed-case Windows marker", () => {
    const env = { ai_agent: " wrapper ", openclaw_cli: "0" } as NodeJS.ProcessEnv;

    ensureOpenClawExecMarkerOnProcess(env, "win32");

    expect(env).toEqual({
      AI_AGENT: " wrapper ",
      OPENCLAW_CLI: OPENCLAW_CLI_ENV_VALUE,
    });
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previousOpenClawCli = process.env[OPENCLAW_CLI_ENV_VAR];
    const previousAiAgent = process.env.AI_AGENT;
    deleteTestEnvValue(OPENCLAW_CLI_ENV_VAR);
    deleteTestEnvValue("AI_AGENT");

    try {
      expect(ensureOpenClawExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[OPENCLAW_CLI_ENV_VAR]).toBe(OPENCLAW_CLI_ENV_VALUE);
      expect(process.env.AI_AGENT).toBe(AI_AGENT_ENV_VALUE);
    } finally {
      if (previousOpenClawCli === undefined) {
        deleteTestEnvValue(OPENCLAW_CLI_ENV_VAR);
      } else {
        setTestEnvValue(OPENCLAW_CLI_ENV_VAR, previousOpenClawCli);
      }
      if (previousAiAgent === undefined) {
        deleteTestEnvValue("AI_AGENT");
      } else {
        setTestEnvValue("AI_AGENT", previousAiAgent);
      }
    }
  });
});
