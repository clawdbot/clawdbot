import { describe, expect, it } from "vitest";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";

describe("resolveSubagentCapabilities", () => {
  it("returns normalized depth for non-finite direct inputs", () => {
    expect(
      resolveSubagentCapabilities({
        depth: Number.NaN,
        maxSpawnDepth: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      depth: 0,
      role: "main",
      controlScope: "children",
      canSpawn: true,
      canControlChildren: true,
    });
  });

  it("floors finite depth and max depth consistently", () => {
    expect(resolveSubagentCapabilities({ depth: 1.9, maxSpawnDepth: 1.2 })).toEqual({
      depth: 1,
      role: "leaf",
      controlScope: "none",
      canSpawn: false,
      canControlChildren: false,
    });
  });
});
