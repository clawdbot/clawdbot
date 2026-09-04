import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveOpenClawConfigPath as resolveConfig,
  resolveOpenClawStateDir as resolveState,
} from "../../scripts/e2e/lib/openclaw-state-paths.mjs";
import { withEnv } from "../../src/test-utils/env.js";

const home = path.join(path.sep, "tmp", "openclaw-home");
const state = path.join(path.sep, "tmp", "openclaw-state");
const rawState = `${state}/../raw `;
const rawConfig = " ./raw config.json ";

describe("OpenClaw E2E state paths", () => {
  it.each([
    ["returns raw state path bytes", resolveState, [home, undefined, rawState], rawState],
    ["preserves whitespace state overrides", resolveState, [home, undefined, " \t "], " \t "],
    [
      "falls back from an empty state override",
      resolveState,
      [home, undefined, ""],
      path.join(home, ".openclaw"),
    ],
    [
      "returns a config override without resolving HOME",
      resolveConfig,
      [undefined, rawConfig, undefined],
      rawConfig,
    ],
    [
      "falls back from an empty config override via state",
      resolveConfig,
      [undefined, "", state],
      path.join(state, "openclaw.json"),
    ],
  ])("%s", (_name, resolve, [HOME, OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR], expected) => {
    withEnv({ HOME, OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR }, () =>
      expect(resolve()).toBe(expected),
    );
  });

  it.each([
    ["state", resolveState],
    ["config", resolveConfig],
  ])("rejects missing HOME for the default %s path", (_name, resolve) => {
    withEnv(
      { HOME: undefined, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
      () => expect(resolve).toThrow(TypeError),
    );
  });
});
