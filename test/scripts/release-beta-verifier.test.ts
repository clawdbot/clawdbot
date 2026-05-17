import { describe, expect, it } from "vitest";
import {
  parseNpmViewFields,
  parseReleaseVerifyBetaArgs,
} from "../../scripts/lib/release-beta-verifier.ts";

describe("parseReleaseVerifyBetaArgs", () => {
  it("defaults beta verification to the matching tag and repo", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3"])).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      workflowRef: undefined,
      pluginSelection: [],
      evidenceOut: undefined,
      skipPostpublish: false,
      rerunFailedClawHub: false,
      workflowRuns: {},
    });
  });

  it("parses child run IDs and repair flags", () => {
    expect(
      parseReleaseVerifyBetaArgs([
        "--",
        "2026.5.10-beta.3",
        "--workflow-ref",
        "release/2026.5.10",
        "--plugins",
        "@openclaw/plugin-a,@openclaw/plugin-b",
        "--full-release-validation-run",
        "10",
        "--openclaw-npm-run",
        "11",
        "--plugin-npm-run",
        "22",
        "--plugin-clawhub-run",
        "33",
        "--npm-telegram-run",
        "44",
        "--evidence-out",
        ".artifacts/release-evidence.json",
        "--skip-postpublish",
        "--rerun-failed-clawhub",
      ]),
    ).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      workflowRef: "release/2026.5.10",
      pluginSelection: ["@openclaw/plugin-a", "@openclaw/plugin-b"],
      evidenceOut: ".artifacts/release-evidence.json",
      skipPostpublish: true,
      rerunFailedClawHub: true,
      workflowRuns: {
        fullReleaseValidation: "10",
        openclawNpm: "11",
        pluginNpm: "22",
        pluginClawHub: "33",
        npmTelegram: "44",
      },
    });
  });
});

describe("parseNpmViewFields", () => {
  it("accepts keyed npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags.beta": "2026.5.10-beta.3",
          "dist.integrity": "sha512-test",
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
    });
  });

  it("accepts nested npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags": { beta: "2026.5.10-beta.3" },
          dist: { integrity: "sha512-test" },
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
    });
  });
});
