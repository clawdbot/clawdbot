import { describe, expect, it } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { findPreparedModelCandidate, listModelSetupPrepareOptions } from "./prepare-options.ts";

function detection(
  candidates: SystemAgentSetupDetectResult["candidates"],
  prepareOptions: NonNullable<SystemAgentSetupDetectResult["prepareOptions"]>,
): SystemAgentSetupDetectResult {
  return {
    candidates,
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    prepareOptions,
    recommendedInstalls: [],
    workspace: "/tmp/workspace",
    setupComplete: false,
  };
}

describe("model setup prepare options", () => {
  it("uses provider identity to hide a usable aliased provider", () => {
    const result = detection(
      [
        {
          kind: "provider-auto:other-choice",
          brandId: "lmstudio",
          label: "LM Studio",
          detail: "available locally",
          modelRef: "lmstudio/qwen3-8b-instruct",
          recommended: false,
          credentials: true,
        },
      ],
      [{ id: "lmstudio-local", brandId: "lmstudio", label: "LM Studio" }],
    );

    expect(listModelSetupPrepareOptions(result)).toEqual([]);
  });

  it("keeps setup available for credential-less candidates", () => {
    const result = detection(
      [
        {
          kind: "provider-auto:lmstudio",
          brandId: "lmstudio",
          label: "LM Studio",
          detail: "API key required",
          modelRef: "lmstudio/qwen3-8b-instruct",
          recommended: false,
          credentials: false,
        },
      ],
      [{ id: "lmstudio", brandId: "lmstudio", label: "LM Studio" }],
    );

    expect(listModelSetupPrepareOptions(result)).toHaveLength(1);
    expect(findPreparedModelCandidate(result, "lmstudio")).toBeUndefined();
  });
});
