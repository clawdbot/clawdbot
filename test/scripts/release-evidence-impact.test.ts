import { describe, expect, it } from "vitest";
import { classifyReleaseEvidenceImpact } from "../../scripts/release-evidence-impact.mjs";

describe("classifyReleaseEvidenceImpact", () => {
  it("reuses product evidence only for an isolated changelog finalization", () => {
    expect(classifyReleaseEvidenceImpact(["CHANGELOG.md"])).toMatchObject({
      changeClass: "changelog-only",
      reusableEvidencePolicy: "changelog-only-release-v1",
      finalPublishRequiresFullValidation: false,
    });
  });

  it("routes release-tooling iteration to a diagnostic release-checks rerun", () => {
    expect(
      classifyReleaseEvidenceImpact([
        ".github/workflows/openclaw-release-publish.yml",
        "scripts/release-candidate-checklist.mjs",
      ]),
    ).toMatchObject({
      changeClass: "release-tooling",
      diagnosticRerunGroups: ["release-checks"],
      finalPublishRequiresFullValidation: true,
    });
  });

  it("routes plugin-only changes to targeted diagnostics without weakening final proof", () => {
    expect(classifyReleaseEvidenceImpact(["extensions/telegram/src/index.ts"])).toMatchObject({
      changeClass: "plugin-product",
      diagnosticRerunGroups: ["plugin-prerelease", "package"],
      finalPublishRequiresFullValidation: true,
    });
  });

  it("keeps mixed product changes on the full validation path", () => {
    expect(
      classifyReleaseEvidenceImpact(["extensions/telegram/src/index.ts", "src/config/config.ts"]),
    ).toMatchObject({
      changeClass: "product",
      diagnosticRerunGroups: ["all"],
      finalPublishRequiresFullValidation: true,
    });
  });
});
