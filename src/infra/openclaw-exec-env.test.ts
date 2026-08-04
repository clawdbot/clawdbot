// Tests OpenClaw execution environment construction.
import { describe, expect, it } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  ensureOpenClawExecMarkerOnProcess,
  markOpenClawExecEnv,
  OPENCLAW_CLI_ENV_VAR,
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
