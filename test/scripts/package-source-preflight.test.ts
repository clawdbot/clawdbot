import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  validatePackageSource,
  validatePackageSourceRef,
} from "../../scripts/package-source-preflight.mjs";

const changelog = `# Changelog

## Unreleased

- Package source preflight notes with enough detail.
`;

function rootManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "openclaw",
    version: "2026.8.1",
    dependencies: {
      "@openclaw/ai": "workspace:*",
      openai: "6.49.0",
    },
    ...overrides,
  });
}

function aiManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "@openclaw/ai",
    version: "2026.8.1",
    dependencies: {
      openai: "6.49.0",
    },
    ...overrides,
  });
}

describe("package source preflight", () => {
  it("accepts aligned source manifests and the explicitly allowed Unreleased section", () => {
    expect(
      validatePackageSource({
        aiManifestContent: aiManifest(),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toBe("2026.8.1");
  });

  it("uses canonical package changelog validation", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest(),
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("CHANGELOG.md does not contain a release section for 2026.8.1.");
  });

  it("rejects source package version drift", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest({ version: "2026.8.2" }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("packages/ai/package.json version must match package.json");
  });

  it("rejects @openclaw/ai dependency drift before packing", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest({
          dependencies: {
            openai: "6.50.0",
          },
        }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow(
      'package.json must match packages/ai/package.json dependency openai@6.50.0; found "6.49.0".',
    );
  });

  it("preserves historical sources from before the @openclaw/ai workspace split", () => {
    expect(
      validatePackageSource({
        aiManifestContent: null,
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest({ dependencies: {} }),
      }),
    ).toBe("2026.8.1");
  });

  it("validates the current source ref without modifying the checkout", () => {
    expect(
      validatePackageSourceRef("HEAD", {
        allowUnreleasedChangelog: true,
      }),
    ).toBe("2026.8.1");
  });

  it("runs before dependency setup only for source-built release packages", () => {
    const workflow = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    ) as {
      jobs: {
        prepare_release_package: {
          steps: Array<{ env?: Record<string, string>; if?: string; name?: string; run?: string }>;
        };
      };
    };
    const steps = workflow.jobs.prepare_release_package.steps;
    const preflightIndex = steps.findIndex(
      (step) => step.name === "Validate release package source metadata",
    );
    const setupIndex = steps.findIndex((step) => step.name === "Setup Node environment");
    const packageIndex = steps.findIndex(
      (step) => step.name === "Resolve release package artifact",
    );
    const preflight = steps[preflightIndex];

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(setupIndex);
    expect(preflightIndex).toBeLessThan(packageIndex);
    expect(preflight).toBeDefined();
    if (!preflight) {
      throw new Error("missing package source preflight step");
    }
    expect(preflight.if).toContain("inputs.candidate_artifact_json == ''");
    expect(preflight.if).toContain("needs.resolve_target.outputs.release_package_spec == ''");
    expect(preflight.env?.PACKAGE_REF).toBe("${{ needs.resolve_target.outputs.revision }}");
    expect(preflight.run).toContain("node scripts/package-source-preflight.mjs");
  });
});
