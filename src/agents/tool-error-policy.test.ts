import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveToolErrorSuppression } from "./tool-error-policy.js";

describe("resolveToolErrorSuppression", () => {
  it.each([
    { name: "uses the default when no policy is configured", config: {}, expected: false },
    {
      name: "inherits the global suppression setting",
      config: { messages: { suppressToolErrors: true } },
      expected: true,
    },
    {
      name: "suppresses one agent when the global setting is off",
      config: {
        messages: { suppressToolErrors: false },
        agents: { entries: { main: { messages: { suppressToolErrors: true } } } },
      },
      expected: true,
    },
    {
      name: "keeps warnings for one agent when the global setting is on",
      config: {
        messages: { suppressToolErrors: true },
        agents: { entries: { main: { messages: { suppressToolErrors: false } } } },
      },
      expected: false,
    },
  ])("$name", ({ config, expected }) => {
    expect(resolveToolErrorSuppression(config as OpenClawConfig, "main")).toBe(expected);
  });
});
