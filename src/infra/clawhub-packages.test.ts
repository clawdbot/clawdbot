// Verifies ClawHub package metadata, security, and artifact resolver APIs.
import { describe, expect, it } from "vitest";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageSecurity,
  resolveLatestVersionFromPackage,
} from "./clawhub-packages.js";

describe("clawhub packages", () => {
  it("resolves latest versions from latestVersion before tags", () => {
    expect(
      resolveLatestVersionFromPackage({
        package: {
          name: "demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          latestVersion: "1.2.3",
          tags: { latest: "1.2.2" },
        },
      }),
    ).toBe("1.2.3");
    expect(
      resolveLatestVersionFromPackage({
        package: {
          name: "demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          tags: { latest: "1.2.2" },
        },
      }),
    ).toBe("1.2.2");
  });

  it("fetches typed package artifact resolver reports", async () => {
    let requestedUrl = "";
    await expect(
      fetchClawHubPackageArtifact({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              artifact: {
                source: "clawhub",
                artifactKind: "npm-pack",
                packageName: "@openclaw/diagnostics-otel",
                version: "2026.3.22",
                downloadUrl: "https://clawhub.ai/api/v1/clawpacks/abc",
                npmIntegrity: "sha512-demo",
                npmShasum: "abc",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toEqual({
      artifact: {
        source: "clawhub",
        artifactKind: "npm-pack",
        packageName: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        downloadUrl: "https://clawhub.ai/api/v1/clawpacks/abc",
        npmIntegrity: "sha512-demo",
        npmShasum: "abc",
      },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22/artifact",
    );
  });

  it("fetches typed package security reports", async () => {
    let requestedUrl = "";
    await expect(
      fetchClawHubPackageSecurity({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              package: {
                name: "@openclaw/diagnostics-otel",
                displayName: "Diagnostics",
                family: "code-plugin",
              },
              release: {
                releaseId: "rel_demo",
                version: "2026.3.22",
              },
              overview: "The plugin uses privileged local APIs.\n\nReview those capabilities.",
              securityAuditUrl:
                "https://clawhub.ai/plugins/@openclaw/diagnostics-otel/security-audit?version=2026.3.22",
              trust: {
                scanStatus: "clean",
                moderationState: null,
                blockedFromDownload: false,
                reasons: [],
                pending: false,
                stale: true,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toEqual({
      package: {
        name: "@openclaw/diagnostics-otel",
        displayName: "Diagnostics",
        family: "code-plugin",
      },
      release: {
        id: "rel_demo",
        version: "2026.3.22",
      },
      overview: "The plugin uses privileged local APIs.\n\nReview those capabilities.",
      securityAuditUrl:
        "https://clawhub.ai/plugins/@openclaw/diagnostics-otel/security-audit?version=2026.3.22",
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: true,
      },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22/security",
    );
  });

  it("rejects malformed package security reports", async () => {
    await expect(
      fetchClawHubPackageSecurity({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              trust: {
                scanStatus: "clean",
                moderationState: null,
                blockedFromDownload: false,
                reasons: "clean",
                pending: false,
                stale: false,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toThrow("expected reasons to be a string array");
  });

  it("rejects package security reports without their audit overview", async () => {
    await expect(
      fetchClawHubPackageSecurity({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              securityAuditUrl:
                "https://clawhub.ai/plugins/@openclaw/diagnostics-otel/security-audit?version=2026.3.22",
              trust: {
                blockedFromDownload: false,
                reasons: [],
                pending: false,
                stale: false,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toThrow("expected overview to be a non-empty string");
  });
});
