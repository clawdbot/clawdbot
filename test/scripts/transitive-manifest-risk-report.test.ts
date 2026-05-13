import { describe, expect, it } from "vitest";
import {
  createTransitiveManifestRiskReport,
  renderTransitiveManifestRiskMarkdownReport,
} from "../../scripts/transitive-manifest-risk-report.mjs";

describe("transitive-manifest-risk-report", () => {
  it("reports floating transitive specs, lifecycle scripts, exotic sources, and recently published versions", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "parent", version: "1.0.0" },
        { packageName: "tarball-package", version: "https://example.test/pkg.tgz" },
      ],
      now: new Date("2026-05-12T00:00:00Z"),
      minimumReleaseAgeMinutes: 2_880,
      manifestLoader: async ({ packageName, version }) => {
        if (packageName !== "parent" || version !== "1.0.0") {
          throw new Error("unexpected manifest request");
        }
        return {
          publishedAt: "2026-05-11T23:00:00Z",
          manifest: {
            dependencies: {
              floating: "^1.2.3",
              exact: "2.0.0",
              gitdep: "github:owner/repo#main",
            },
            optionalDependencies: {
              optionalFloating: "~3.0.0",
            },
            scripts: {
              install: "node install.js",
            },
          },
        };
      },
    });

    expect(report.byType).toEqual({
      "exotic-source": 2,
      "floating-transitive-spec": 3,
      "lifecycle-script": 1,
      "recently-published-version": 1,
    });
    expect(report.workspaceExcludedFindings).toEqual([]);
    expect(report.metadataFailures).toEqual([]);
  });

  it("uses pnpm minimum release age exclusions for recently published versions", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "regular", version: "1.0.0" },
        { packageName: "exact-package", version: "2.0.0" },
        { packageName: "either-version", version: "5.102.1" },
        { packageName: "@scope/native-linux-x64", version: "3.0.0" },
      ],
      now: new Date("2026-05-12T00:00:00Z"),
      minimumReleaseAgeMinutes: 2_880,
      minimumReleaseAgeExclude: [
        "exact-package@2.0.0",
        "either-version@4.47.0 || 5.102.1",
        "@scope/native-*",
      ],
      manifestLoader: async () => ({
        publishedAt: "2026-05-11T23:00:00Z",
        manifest: {},
      }),
    });

    expect(report.byType).toEqual({
      "recently-published-version": 1,
    });
    expect(report.workspaceExcludedByType).toEqual({
      "recently-published-version": 3,
    });
    expect(report.findings).toMatchObject([
      {
        packageName: "regular",
        type: "recently-published-version",
      },
    ]);
    expect(report.workspaceExcludedFindings).toMatchObject([
      {
        packageName: "@scope/native-linux-x64",
        type: "recently-published-version",
        workspaceExcluded: true,
        workspaceExclusion: "@scope/native-*",
      },
      {
        packageName: "either-version",
        type: "recently-published-version",
        workspaceExcluded: true,
        workspaceExclusion: "either-version@4.47.0 || 5.102.1",
      },
      {
        packageName: "exact-package",
        type: "recently-published-version",
        workspaceExcluded: true,
        workspaceExclusion: "exact-package@2.0.0",
      },
    ]);

    const markdown = renderTransitiveManifestRiskMarkdownReport(report);
    expect(markdown).toContain(
      "## Recently Published Versions Not Covered By Workspace Exclusions",
    );
    expect(markdown).toContain("## Recently Published Versions Covered By Workspace Exclusions");
    expect(markdown).toContain("Workspace minimum release age: 2880 minutes.");
    expect(markdown).toContain("`regular@1.0.0`: published 2026-05-11T23:00:00Z");
    expect(markdown).toContain(
      "`exact-package@2.0.0`: published 2026-05-11T23:00:00Z; workspace exclusion `exact-package@2.0.0`",
    );
    expect(markdown).not.toContain(
      "`regular@1.0.0`: published 2026-05-11T23:00:00Z; minimum release age 2880 minutes",
    );
  });

  it("documents JSON completeness and renders grouped Markdown summaries", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "@earendil-works/pi-ai", version: "0.74.0" },
        { packageName: "aaa-package", version: "1.0.0" },
        { packageName: "recent-package", version: "1.0.0" },
      ],
      now: new Date("2026-05-12T00:00:00Z"),
      minimumReleaseAgeMinutes: 2_880,
      minimumReleaseAgeExclude: ["recent-package@1.0.0"],
      manifestLoader: async ({ packageName }) => ({
        publishedAt:
          packageName === "recent-package" ? "2026-05-11T23:00:00Z" : "2026-04-01T00:00:00Z",
        manifest:
          packageName === "@earendil-works/pi-ai"
            ? {
                dependencies: {
                  "@mistralai/mistralai": "^2.2.0",
                },
              }
            : packageName === "recent-package"
              ? {
                  dependencies: {
                    "recent-dependency": "^1.0.0",
                  },
                }
              : {
                  dependencies: {
                    "aaa-dependency": "^1.0.0",
                  },
                },
      }),
    });

    const markdown = renderTransitiveManifestRiskMarkdownReport(report);

    expect(markdown).toContain("# Transitive Manifest Risk Report");
    expect(markdown).toContain("## Scope");
    expect(markdown).toContain("published package manifests for resolved packages");
    expect(markdown).toContain("It is report-only.");
    expect(markdown).toContain("Resolved package versions inspected");
    expect(markdown).toContain("Reported risk signals");
    expect(markdown).toContain("Signals covered by workspace policy exclusions");
    expect(markdown).toContain("## Reported Risk Signals By Type");
    expect(markdown).toContain("## Signals Covered By Workspace Policy Exclusions");
    expect(markdown).toContain("not included in the reported risk signal totals");
    expect(markdown).toContain("## Complete Evidence");
    expect(markdown).toContain("The complete reported signal list is available in the JSON report");
    expect(markdown).toContain("## Published Package Manifests With Risk Findings");
    expect(markdown).toContain("`@earendil-works/pi-ai@0.74.0`: 1 manifest finding");
    expect(markdown).toContain("`aaa-package@1.0.0`: 1 manifest finding");
    expect(markdown).toContain("## Floating Dependency Targets");
    expect(markdown).toContain("`@mistralai/mistralai`: 1 declarations");
    expect(markdown).toContain("`aaa-dependency`: 1 declarations");
    expect(markdown).not.toContain("## Packages With Findings");
    expect(markdown).not.toContain("## Finding Details");
    expect(markdown).not.toContain("## Notable Findings");
    expect(markdown).not.toContain("## Additional Sample Findings");
  });
});
