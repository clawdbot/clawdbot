import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { resolveMatrixQaScenarioIds } from "./profiles.js";

const MATRIX_QA_PROFILE_NAMES = [
  "all",
  "fast",
  "release",
  "transport",
  "media",
  "e2ee-smoke",
  "e2ee-deep",
  "e2ee-cli",
] as const;

describe("QA Lab Matrix profiles", () => {
  it("preserves the profile sizes and default selection", () => {
    const allScenarioIds = resolveMatrixQaScenarioIds({ profile: "all" });
    expect(allScenarioIds).toHaveLength(93);
    expect(resolveMatrixQaScenarioIds({ profile: "fast" })).toHaveLength(12);
    expect(resolveMatrixQaScenarioIds({ profile: "release" })).toEqual([
      "channel-chat-baseline",
      "matrix-allowlist-hot-reload",
    ]);
    expect(resolveMatrixQaScenarioIds({ profile: "transport" })).toHaveLength(50);
    expect(resolveMatrixQaScenarioIds({ profile: "media" })).toHaveLength(7);
    expect(resolveMatrixQaScenarioIds({ profile: "e2ee-smoke" })).toHaveLength(8);
    expect(resolveMatrixQaScenarioIds({ profile: "e2ee-deep" })).toHaveLength(18);
    expect(resolveMatrixQaScenarioIds({ profile: "e2ee-cli" })).toHaveLength(9);
    expect(resolveMatrixQaScenarioIds({})).toEqual(allScenarioIds);
    expect(resolveMatrixQaScenarioIds({ profile: "fast" })).toContain("channel-chat-baseline");
    expect(allScenarioIds).toContain("channel-chat-baseline");
  });

  it("keeps every profile unique, catalog-backed, and contained by all", () => {
    const allScenarioIds = resolveMatrixQaScenarioIds({ profile: "all" });
    const allScenarioIdSet = new Set(allScenarioIds);
    for (const profile of MATRIX_QA_PROFILE_NAMES) {
      const scenarioIds = resolveMatrixQaScenarioIds({ profile });
      expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
      for (const scenarioId of scenarioIds) {
        expect(readQaScenarioById(scenarioId).id).toBe(scenarioId);
        if (profile !== "all") {
          expect(allScenarioIdSet.has(scenarioId), `${profile}:${scenarioId}`).toBe(true);
        }
      }
    }
  });

  it("keeps explicit-only scenarios out of every named profile", () => {
    const profileScenarioIds = MATRIX_QA_PROFILE_NAMES.flatMap((profile) =>
      resolveMatrixQaScenarioIds({ profile }),
    );

    expect(profileScenarioIds).not.toContain("matrix-room-block-streaming");
    expect(profileScenarioIds).not.toContain("subagent-thread-spawn");
  });
});
