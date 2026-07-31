import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { shouldIncludeHook } from "./config.js";
import { buildWorkspaceHookStatus } from "./hooks-status.js";
import type { HookEntry } from "./types.js";

const ENV_NAME = "OPENCLAW_TEST_HOOK_REQUIRED_ENV";
const HOOK_NAME = "required-env-hook";

const entry: HookEntry = {
  hook: {
    name: HOOK_NAME,
    description: "Requires an environment variable",
    source: "openclaw-bundled",
    filePath: "/tmp/HOOK.md",
    baseDir: "/tmp",
    handlerPath: "/tmp/handler.js",
  },
  frontmatter: {},
  metadata: {
    events: ["command:new"],
    requires: { env: [ENV_NAME] },
  },
};

function configWithEnv(value: string): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          [HOOK_NAME]: { env: { [ENV_NAME]: value } },
        },
      },
    },
  };
}

function evaluate(config?: OpenClawConfig) {
  const runtimeIncluded = shouldIncludeHook({ entry, config });
  const status = buildWorkspaceHookStatus("/tmp", { entries: [entry], config }).hooks[0];
  return { runtimeIncluded, status };
}

describe("hook environment requirements", () => {
  it.each([
    { name: "missing values", hostEnv: undefined, configEnv: undefined, satisfied: false },
    { name: "blank host env", hostEnv: " \t ", configEnv: undefined, satisfied: false },
    { name: "blank config env", hostEnv: undefined, configEnv: " \n ", satisfied: false },
    { name: "valid host env", hostEnv: " host-token ", configEnv: undefined, satisfied: true },
    { name: "valid config env", hostEnv: undefined, configEnv: " config-token ", satisfied: true },
    {
      name: "valid config env after blank host env",
      hostEnv: "   ",
      configEnv: " config-token ",
      satisfied: true,
    },
  ])("keeps runtime and status aligned for $name", ({ hostEnv, configEnv, satisfied }) => {
    const { runtimeIncluded, status } = withEnv({ [ENV_NAME]: hostEnv }, () =>
      evaluate(configEnv === undefined ? undefined : configWithEnv(configEnv)),
    );

    expect(runtimeIncluded).toBe(satisfied);
    expect(status?.requirementsSatisfied).toBe(satisfied);
    expect(status?.loadable).toBe(satisfied);
    expect(status?.missing.env).toEqual(satisfied ? [] : [ENV_NAME]);
  });
});
