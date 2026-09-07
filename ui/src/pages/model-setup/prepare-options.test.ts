import { describe, expect, it } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import {
  findPreparedModelCandidate,
  listModelSetupPrepareOptions,
  providerAutoSetupKind,
} from "./prepare-options.ts";

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
  it("encodes provider choice ids in setup kinds", () => {
    const choiceId = "vendor/local:v1%beta?x#y";
    const kind = "provider-auto:vendor%2Flocal%3Av1%25beta%3Fx%23y";
    expect(providerAutoSetupKind(choiceId)).toBe(kind);
    const candidate: SystemAgentSetupDetectResult["candidates"][number] = {
      kind,
      brandId: "vendor",
      label: "Vendor Local",
      detail: "available locally",
      modelRef: "vendor/model",
      recommended: false,
      credentials: true,
    };
    const result = detection(
      [candidate],
      [{ id: choiceId, brandId: "vendor", label: "Vendor Local" }],
    );

    expect(listModelSetupPrepareOptions(result)).toEqual([]);
    expect(findPreparedModelCandidate(result, choiceId)).toEqual(candidate);
  });

  it("does not treat raw reserved choice ids as canonical kinds", () => {
    expect(providerAutoSetupKind("local/provider%beta")).not.toBe(
      "provider-auto:local/provider%beta",
    );
  });

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
