import { describe, expect, it } from "vitest";
import { normalizeXaiModelId } from "./api.js";

describe("normalizeXaiModelId", () => {
  it("maps deprecated grok 4.20 beta ids to GA ids", () => {
    expect(normalizeXaiModelId("grok-4.20-experimental-beta-0304-reasoning")).toBe(
      "grok-4.20-beta-latest-reasoning",
    );
    expect(normalizeXaiModelId("grok-4.20-experimental-beta-0304-non-reasoning")).toBe(
      "grok-4.20-beta-latest-non-reasoning",
    );
  });

  it("maps older fast and 4.20 ids to the current Pi-backed ids", () => {
    expect(normalizeXaiModelId("grok-4-fast-reasoning")).toBe("grok-4-fast");
    expect(normalizeXaiModelId("grok-4-1-fast-reasoning")).toBe("grok-4-1-fast");
    expect(normalizeXaiModelId("grok-4.20-reasoning")).toBe("grok-4.20-beta-latest-reasoning");
    expect(normalizeXaiModelId("grok-4.20-non-reasoning")).toBe(
      "grok-4.20-beta-latest-non-reasoning",
    );
  });

  it("leaves current xai model ids unchanged", () => {
    expect(normalizeXaiModelId("grok-4.20-beta-latest-reasoning")).toBe(
      "grok-4.20-beta-latest-reasoning",
    );
    expect(normalizeXaiModelId("grok-4")).toBe("grok-4");
  });
});
