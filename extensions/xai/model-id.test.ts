// Xai tests cover model id plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeXaiModelId } from "./api.js";

describe("normalizeXaiModelId", () => {
  it("normalizes family-specific aliases but preserves the global alias", () => {
    expect(normalizeXaiModelId("grok-4.3-latest")).toBe("grok-4.3");
    expect(normalizeXaiModelId("grok-latest")).toBe("grok-latest");
    expect(normalizeXaiModelId("grok-4.5-latest")).toBe("grok-4.5");
  });

  it("normalizes the current Grok Build alias", () => {
    expect(normalizeXaiModelId("grok-build-latest")).toBe("grok-4.5");
  });

  it("preserves provider-owned Grok 4.20 aliases", () => {
    expect(normalizeXaiModelId("grok-4.20-experimental-beta-0304-reasoning")).toBe(
      "grok-4.20-experimental-beta-0304-reasoning",
    );
    expect(normalizeXaiModelId("grok-4.20-experimental-beta-0304-non-reasoning")).toBe(
      "grok-4.20-experimental-beta-0304-non-reasoning",
    );
  });

  it("maps retired code and fast ids to current OpenClaw-backed ids", () => {
    expect(normalizeXaiModelId("grok-code-fast-1")).toBe("grok-build-0.1");
    expect(normalizeXaiModelId("grok-code-fast")).toBe("grok-build-0.1");
    expect(normalizeXaiModelId("grok-code-fast-1-0825")).toBe("grok-build-0.1");
    expect(normalizeXaiModelId("grok-4-fast-reasoning")).toBe("grok-4-fast");
    expect(normalizeXaiModelId("grok-4-1-fast-reasoning")).toBe("grok-4-1-fast");
    expect(normalizeXaiModelId("grok-4.20-reasoning")).toBe("grok-4.20-reasoning");
    expect(normalizeXaiModelId("grok-4.20-non-reasoning")).toBe("grok-4.20-non-reasoning");
  });

  it("leaves current xai model ids unchanged", () => {
    expect(normalizeXaiModelId("grok-4.20-beta-latest-reasoning")).toBe(
      "grok-4.20-beta-latest-reasoning",
    );
    expect(normalizeXaiModelId("grok-4.20-0309-reasoning")).toBe("grok-4.20-0309-reasoning");
    expect(normalizeXaiModelId("grok-4")).toBe("grok-4");
  });
});
