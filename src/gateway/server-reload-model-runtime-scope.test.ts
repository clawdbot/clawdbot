import { describe, expect, it } from "vitest";
import { resolveModelRuntimeAgentIdsFromChangedPaths } from "./server-reload-model-runtime-scope.js";

describe("prepared model runtime reload scope", () => {
  it("collects normalized agent ids from agent-entry-local paths", () => {
    expect(
      resolveModelRuntimeAgentIdsFromChangedPaths([
        "agents.entries.Alpha.model",
        "agents.entries.beta.name",
      ]),
    ).toEqual(new Set(["alpha", "beta"]));
  });

  it("ignores machine-managed metadata beside an agent-local path", () => {
    expect(
      resolveModelRuntimeAgentIdsFromChangedPaths([
        "agents.entries.alpha.model",
        "meta.lastTouchedAt",
      ]),
    ).toEqual(new Set(["alpha"]));
  });

  it.each([
    [[]],
    [["agents.entries"]],
    [["agents.entries.alpha.model", "models.providers.openai.api"]],
  ])("falls back to full refresh for an unbounded path set: %j", (paths) => {
    expect(resolveModelRuntimeAgentIdsFromChangedPaths(paths)).toBeUndefined();
  });
});
