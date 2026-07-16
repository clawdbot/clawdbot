import { describe, expect, it } from "vitest";
import { readDraftCloudProfiles } from "./discovery.ts";

describe("readDraftCloudProfiles", () => {
  it("keeps closed profile summaries in stable order", () => {
    expect(
      readDraftCloudProfiles([
        null,
        42,
        { id: " zeta ", providerId: " static-ssh ", settings: { token: "hidden" } },
        { id: "aws", providerId: "crabbox" },
        { id: "", providerId: "crabbox" },
        { id: "missing-provider" },
      ]),
    ).toEqual([
      { id: "aws", providerId: "crabbox" },
      { id: "zeta", providerId: "static-ssh" },
    ]);
  });
});
