import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeDeclaredSurfaceHash } from "./capability-consent.js";
import {
  emptyMetadataSnapshot,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), officialCatalog: vi.fn() }));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { clearManagedPluginOfficialCatalogCache, inspectManagedPlugin } =
  await import("./management-service.js");

describe("managed plugin inspection", () => {
  beforeEach(() => {
    clearManagedPluginOfficialCatalogCache();
    mocks.metadata.mockReset();
    mocks.officialCatalog.mockReset();
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  });

  it("inspects bundled plugin metadata with its effective default hook grants", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: true }));

    const inspection = await inspectManagedPlugin({
      config: {},
      env: {},
      pluginId: "workboard",
    });

    expect(inspection).toMatchObject({
      ok: true,
      plugin: {
        id: "workboard",
        name: "Workboard",
        description: "Coordinate agent work in a shared board.",
        origin: "bundled",
        installed: true,
        enabled: true,
      },
      source: { kind: "bundled" },
      reviewToken: expect.stringMatching(/^[a-f\d]{64}$/),
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: true },
        },
      },
    });
    expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
    expect(inspection).not.toHaveProperty("trust");
  });

  it("inspects tracked external provenance, pinned integrity, operator grants, and trust", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "community-plugin",
        name: "Community Plugin",
        enabled: false,
        origin: "global",
        installRecord: {
          source: "clawhub",
          installPath: "/tmp/community-plugin",
          spec: "clawhub:community/plugin",
          resolvedSpec: "clawhub:community/plugin@1.2.3",
          clawhubPackage: "community/plugin",
          integrity: "sha512-primary",
          npmIntegrity: "sha512-secondary",
          clawpackSha256: "archive-digest",
          clawhubTrustDisposition: "review-required",
          clawhubTrustReasons: ["Install script"],
          clawhubTrustCheckedAt: "2026-08-25T00:00:00.000Z",
          clawhubTrustAcknowledgedAt: "2026-08-25T01:00:00.000Z",
          clawhubTrustPending: false,
          clawhubTrustStale: true,
        },
      }),
    );

    const inspection = await inspectManagedPlugin({
      config: {
        plugins: {
          entries: {
            "community-plugin": {
              hooks: { allowPromptInjection: false, allowConversationAccess: true },
              llm: { allowModelOverride: true },
            },
          },
        },
      },
      env: {},
      pluginId: "community-plugin",
    });

    expect(inspection).toMatchObject({
      plugin: { id: "community-plugin", name: "Community Plugin", enabled: false },
      source: {
        kind: "clawhub",
        spec: "clawhub:community/plugin@1.2.3",
        packageName: "community/plugin",
        integrity: "sha512-primary",
        integrityKind: "ssri",
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: false, configured: false },
          allowConversationAccess: { effective: true, configured: true },
        },
        llm: { allowModelOverride: true },
      },
      trust: {
        disposition: "review-required",
        reasons: ["Install script"],
        checkedAt: "2026-08-25T00:00:00.000Z",
        acknowledgedAt: "2026-08-25T01:00:00.000Z",
        pending: false,
        stale: true,
      },
    });
    expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
  });

  it("does not misrepresent an npm SHA-1 shasum as pinned SHA-256 integrity", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "community-plugin",
        name: "Community Plugin",
        enabled: false,
        origin: "global",
        installRecord: {
          source: "npm",
          installPath: "/tmp/community-plugin",
          shasum: "0123456789abcdef0123456789abcdef01234567",
          npmShasum: "fedcba9876543210fedcba9876543210fedcba987",
        },
      }),
    );

    const inspection = await inspectManagedPlugin({
      config: {},
      env: {},
      pluginId: "community-plugin",
    });

    expect(inspection.source).toEqual({
      kind: "npm",
      packageName: "@openclaw/community-plugin",
    });
  });

  it.each(["spec", "resolvedSpec"] as const)(
    "redacts credentials from the persisted %s without changing the install record",
    async (field) => {
      const url = new URL("https://example.invalid/plugins/demo.git");
      url.username = "fixture-user";
      url.password = "fixture-password";
      url.searchParams.set("token", "fixture-token");
      url.searchParams.set("ref", "stable");
      const spec = `git:${url.href}`;
      const metadata = metadataSnapshot({
        id: "community-plugin",
        origin: "global",
        enabled: false,
        installRecord: { source: "git", installPath: "/tmp/community-plugin", [field]: spec },
      });
      mocks.metadata.mockReturnValue(metadata);

      const inspection = await inspectManagedPlugin({
        config: {},
        env: {},
        pluginId: "community-plugin",
      });

      expect(inspection.source?.spec).toBe(
        "git:https://***:***@example.invalid/plugins/demo.git?token=***&ref=stable",
      );
      expect(metadata.index.installRecords["community-plugin"]?.[field]).toBe(spec);
    },
  );

  it("inspects official catalog manifests and their actual pinned install candidate", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [hostedFeedDiffsEntry] });

    const inspection = await inspectManagedPlugin({ config: {}, env: {}, pluginId: "diffs" });

    expect(inspection).toMatchObject({
      plugin: { id: "diffs", name: "Diffs", origin: "official", installed: false, enabled: false },
      source: {
        kind: "official-catalog",
        packageName: "@openclaw/diffs",
        integrity: expect.stringMatching(/^sha256-/),
        integrityKind: "sha256",
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: false },
        },
      },
    });
    expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
  });

  it("rejects inspection ids absent from installed metadata and the official catalog", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    await expect(
      inspectManagedPlugin({ config: {}, env: {}, pluginId: "unknown" }),
    ).rejects.toMatchObject({ kind: "invalid-request", message: 'Plugin "unknown" not found.' });
  });
});
