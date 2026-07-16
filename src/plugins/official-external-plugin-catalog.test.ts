import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import {
  type HostedOfficialExternalPluginCatalogSnapshot,
  type HostedOfficialExternalPluginCatalogSnapshotStore,
  type OfficialExternalPluginCatalogEntry,
  type OfficialExternalPluginCatalogFeed,
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  isOfficialExternalPluginCatalogFeed,
  listOfficialExternalPluginCatalogEntries,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

function expectCatalogEntry(id: string): OfficialExternalPluginCatalogEntry {
  const entry = getOfficialExternalPluginCatalogEntry(id);
  if (entry === undefined) {
    throw new Error(`Expected external plugin catalog entry for ${id}`);
  }
  return entry;
}

const HOSTED_CATALOG_PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

type HostedCatalogConfig = NonNullable<
  NonNullable<
    Parameters<typeof loadConfiguredHostedOfficialExternalPluginCatalogEntries>[0]
  >["marketplaces"]
>;
type ConfiguredHostedCatalogLoadParams = NonNullable<
  Parameters<typeof loadConfiguredHostedOfficialExternalPluginCatalogEntries>[1]
>;
type HostedCatalogLoadParams = ConfiguredHostedCatalogLoadParams & {
  catalogConfig?: HostedCatalogConfig;
};

function loadHostedCatalog(
  params: HostedCatalogLoadParams = {},
): ReturnType<typeof loadConfiguredHostedOfficialExternalPluginCatalogEntries> {
  const { catalogConfig, ...loadParams } = params;
  return loadConfiguredHostedOfficialExternalPluginCatalogEntries(
    catalogConfig ? { marketplaces: catalogConfig } : undefined,
    loadParams,
  );
}

function createInMemoryHostedCatalogSnapshotStore(
  initialSnapshots: HostedOfficialExternalPluginCatalogSnapshot[] = [],
): HostedOfficialExternalPluginCatalogSnapshotStore {
  const snapshots = new Map<string, HostedOfficialExternalPluginCatalogSnapshot>();
  for (const snapshot of initialSnapshots) {
    snapshots.set(snapshot.metadata.url, snapshot);
  }
  return {
    async read(url) {
      return snapshots.get(url) ?? null;
    },
    async write(snapshot) {
      snapshots.set(snapshot.metadata.url, snapshot);
    },
  };
}

function hostedCatalogFeed(params: {
  sequence: number;
  pluginName: string;
}): OfficialExternalPluginCatalogFeed {
  const pluginId = params.pluginName.replace(/^@[^/]+\//u, "");
  return {
    schemaVersion: 1,
    id: "openclaw-official-external-plugins",
    generatedAt: `2026-06-22T00:00:${String(params.sequence).padStart(2, "0")}.000Z`,
    sequence: params.sequence,
    entries: [
      {
        name: params.pluginName,
        kind: "plugin",
        openclaw: {
          plugin: { id: pluginId },
          install: { sourceRef: "acme-npm", npmSpec: params.pluginName },
        },
      },
    ],
  };
}

function signedHostedCatalogFeed(params: {
  feed: OfficialExternalPluginCatalogFeed;
  privateKeyPem?: string;
}): { body: string; privateKeyPem: string; publicKeyPem: string } {
  const keys = params.privateKeyPem
    ? {
        privateKeyPem: params.privateKeyPem,
        publicKeyPem: crypto
          .createPublicKey(params.privateKeyPem)
          .export({ type: "spki", format: "pem" }),
      }
    : (() => {
        const generated = crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        return { privateKeyPem: generated.privateKey, publicKeyPem: generated.publicKey };
      })();
  const payloadBytes = Buffer.from(JSON.stringify(params.feed), "utf8");
  const payloadTypeBytes = Buffer.from(HOSTED_CATALOG_PAYLOAD_TYPE, "utf8");
  const signingInput = Buffer.concat([
    Buffer.from(
      `DSSEv1 ${payloadTypeBytes.length} ${HOSTED_CATALOG_PAYLOAD_TYPE} ${payloadBytes.length} `,
      "utf8",
    ),
    payloadBytes,
  ]);
  return {
    body: JSON.stringify({
      schemaVersion: 1,
      payloadType: HOSTED_CATALOG_PAYLOAD_TYPE,
      payload: payloadBytes.toString("base64url"),
      signatures: [
        {
          keyId: "acme-root",
          algorithm: "ed25519",
          signature: crypto
            .sign(null, signingInput, crypto.createPrivateKey(keys.privateKeyPem))
            .toString("base64url"),
        },
      ],
    }),
    ...keys,
  };
}

function signedCatalogConfig(publicKeyPem: string): HostedCatalogConfig {
  return {
    feeds: {
      acme: {
        url: "https://packages.acme.example/openclaw/feed",
        verification: {
          mode: "signed",
          keys: [{ keyId: "acme-root", publicKey: publicKeyPem }],
        },
      },
    },
    sources: {
      "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
    },
  };
}

describe("official external plugin catalog", () => {
  it("keeps hosted fetch guard loading lazy for bundled catalog import paths", () => {
    const source = readFileSync(
      new URL("./official-external-plugin-catalog.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from ["']\.\.\/infra\/net\/fetch-guard\.js["']/);
    expect(source).toContain('await import("../infra/net/fetch-guard.js")');
  });

  it("ships the official plugin catalog as a feed-shaped bundled fallback", () => {
    expect(isOfficialExternalPluginCatalogFeed(officialExternalPluginCatalog)).toBe(true);
    expect(officialExternalPluginCatalog).toMatchObject({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      sequence: 1,
    });
    expect(officialExternalPluginCatalog.entries.length).toBeGreaterThan(0);
  });

  it("curates featured external plugins with ClawHub install alternatives", () => {
    const featured = [
      ["diffs", "@openclaw/diffs", 40],
      ["lobster", "@openclaw/lobster", 50],
      ["tokenjuice", "@openclaw/tokenjuice", 60],
      ["memory-lancedb", "@openclaw/memory-lancedb", 70],
    ] as const;

    for (const [id, npmSpec, order] of featured) {
      const entry = expectCatalogEntry(id);
      expect(getOfficialExternalPluginCatalogManifest(entry)?.catalog).toEqual({
        featured: true,
        order,
      });
      expect(resolveOfficialExternalPluginInstall(entry)).toMatchObject({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
      });
    }
  });

  it("does not allow malformed feed wrappers to count as feed documents", () => {
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 1,
        id: " ",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [],
      }),
    ).toBe(false);
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 2,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [],
      }),
    ).toBe(true);
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 3,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [],
      }),
    ).toBe(false);
  });

  it("accepts the live ClawHub feed schema version", () => {
    expect(
      isOfficialExternalPluginCatalogFeed({
        schemaVersion: 2,
        id: "clawhub-official",
        generatedAt: "2026-06-25T01:19:39.629Z",
        sequence: 11,
        entries: [],
      }),
    ).toBe(true);
  });

  it("loads schema-v2 marketplace entries and gates installs by state and trust", async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          type: "plugin",
          id: "@acme/trusted",
          title: "Trusted",
          version: "1.2.3",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@acme/trusted",
                version: "1.2.3",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@acme/disabled",
          version: "1.0.0",
          state: "disabled",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@acme/disabled",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@acme/community",
          version: "1.0.0",
          state: "available",
          publisher: { id: "acme", trust: "community" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@acme/community",
                version: "1.0.0",
              },
            ],
          },
        },
      ],
    });
    const result = await loadHostedCatalog({
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "@acme/trusted",
      "@acme/disabled",
      "@acme/community",
    ]);
    const [trusted, disabled, community] = result.entries;
    if (!trusted || !disabled || !community) {
      throw new Error("expected schema-v2 marketplace entries");
    }
    expect(resolveOfficialExternalPluginInstall(trusted)).toEqual({
      clawhubSpec: "clawhub:@acme/trusted@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
    });
    expect(resolveOfficialExternalPluginInstall(disabled)).toBeNull();
    expect(resolveOfficialExternalPluginInstall(community)).toBeNull();
  });

  it("reads and updates hosted catalog snapshots in the SQLite store", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-hosted-store-"));
    try {
      const store = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({ stateDir });
      const url = "https://clawhub.ai/v1/feeds/plugins";

      const firstBody = JSON.stringify({ entries: [] });
      const secondBody = JSON.stringify({ entries: [{}] });

      await expect(store.read(url)).resolves.toBeNull();
      await store.write({
        body: firstBody,
        metadata: {
          url,
          status: 200,
          etag: '"first"',
          checksum: "sha256:first",
        },
        savedAt: "2026-06-22T02:03:04.000Z",
      });
      await store.write({
        body: secondBody,
        metadata: {
          url,
          status: 200,
          lastModified: "Mon, 22 Jun 2026 03:00:00 GMT",
          checksum: "sha256:second",
        },
        savedAt: "2026-06-22T03:04:05.000Z",
        trust: {
          mode: "signed",
          signedBy: "acme-root",
          signatureCount: 1,
          threshold: 1,
          verifiedAt: "2026-06-22T03:04:05.000Z",
        },
      });

      await expect(store.read(url)).resolves.toMatchObject({
        body: secondBody,
        metadata: {
          url,
          status: 200,
          lastModified: "Mon, 22 Jun 2026 03:00:00 GMT",
          checksum: "sha256:second",
        },
        savedAt: "2026-06-22T03:04:05.000Z",
        trust: {
          mode: "signed",
          signedBy: "acme-root",
          signatureCount: 1,
          threshold: 1,
          verifiedAt: "2026-06-22T03:04:05.000Z",
        },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps signed SQLite snapshot writes monotonic when writes compete", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-signed-snapshot-race-"));
    const url = "https://packages.acme.example/openclaw/feed";
    const newer = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 10, pluginName: "@openclaw/signed-v10" }),
    });
    const older = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 9, pluginName: "@openclaw/signed-v9" }),
      privateKeyPem: newer.privateKeyPem,
    });
    const snapshotStore = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({
      stateDir,
    });
    const snapshotFor = (body: string, sequence: number) => ({
      body,
      metadata: {
        url,
        status: 200,
        checksum: `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`,
      },
      savedAt: "2026-06-22T00:00:10.000Z",
      trust: {
        mode: "signed" as const,
        signedBy: "acme-root",
        signatureCount: 1,
        threshold: 1,
        verifiedAt: "2026-06-22T00:00:10.000Z",
      },
      monotonic: {
        mode: "signed-feed" as const,
        sequence,
        generatedAt: `2026-06-22T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      },
    });

    try {
      const [newerWrite, olderWrite] = await Promise.allSettled([
        snapshotStore.write(snapshotFor(newer.body, 10)),
        snapshotStore.write(snapshotFor(older.body, 9)),
      ]);

      expect(newerWrite.status).toBe("fulfilled");
      expect(olderWrite).toMatchObject({
        status: "rejected",
        reason: { message: "hosted catalog signed feed sequence is older than current snapshot" },
      });
      await expect(snapshotStore.read(url)).resolves.toMatchObject({ body: newer.body });
    } finally {
      closeOpenClawStateDatabaseForTest();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("verifies signed hosted feeds and rejects rollback before replacing snapshots", async () => {
    const newer = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 10, pluginName: "@openclaw/signed-v10" }),
    });
    const older = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 9, pluginName: "@openclaw/signed-v9" }),
      privateKeyPem: newer.privateKeyPem,
    });
    const snapshotStore = createInMemoryHostedCatalogSnapshotStore();
    const catalogConfig = signedCatalogConfig(newer.publicKeyPem);

    const accepted = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () => new Response(newer.body, { status: 200 })),
      now: () => new Date("2026-06-22T00:00:10.000Z"),
      snapshotStore,
    });

    expect(accepted.source).toBe("hosted");
    expect(accepted.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-v10"]);
    if (accepted.source === "hosted") {
      expect(accepted.trust).toMatchObject({
        mode: "signed",
        signedBy: "acme-root",
        signatureCount: 1,
        threshold: 1,
      });
    }

    const writeSpy = vi.spyOn(snapshotStore, "write");
    const rolledBack = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () => new Response(older.body, { status: 200 })),
      now: () => new Date("2026-06-22T00:00:11.000Z"),
      snapshotStore,
    });

    expect(rolledBack.source).toBe("hosted-snapshot");
    expect(rolledBack.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-v10"]);
    if (rolledBack.source === "hosted-snapshot") {
      expect(rolledBack.error).toContain("signed feed sequence is older");
    }
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("fails closed for unsigned signed-profile responses and re-verifies offline snapshots", async () => {
    const signed = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/signed-offline" }),
    });
    const catalogConfig = signedCatalogConfig(signed.publicKeyPem);
    const unsignedBody = JSON.stringify(
      hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/unsigned" }),
    );

    const unsigned = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () => new Response(unsignedBody, { status: 200 })),
      snapshotStore: createInMemoryHostedCatalogSnapshotStore(),
    });

    expect(unsigned.source).toBe("bundled-fallback");
    expect(unsigned.entries).toEqual([]);
    if (unsigned.source === "bundled-fallback") {
      expect(unsigned.error).toContain("signed envelope is malformed");
    }

    const signedSnapshot = createInMemoryHostedCatalogSnapshotStore([
      {
        body: signed.body,
        metadata: {
          url: "https://packages.acme.example/openclaw/feed",
          status: 200,
          checksum: `sha256:${crypto.createHash("sha256").update(signed.body).digest("hex")}`,
        },
        savedAt: "2026-06-22T00:00:08.000Z",
        trust: {
          mode: "signed",
          signedBy: "acme-root",
          signatureCount: 1,
          threshold: 1,
          verifiedAt: "2026-06-22T00:00:08.000Z",
        },
      },
    ]);
    const offline = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig,
      offline: true,
      snapshotStore: signedSnapshot,
    });

    expect(offline.source).toBe("hosted-snapshot");
    expect(offline.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-offline"]);

    const unsignedSnapshot = createInMemoryHostedCatalogSnapshotStore([
      {
        body: unsignedBody,
        metadata: {
          url: "https://packages.acme.example/openclaw/feed",
          status: 200,
          checksum: `sha256:${crypto.createHash("sha256").update(unsignedBody).digest("hex")}`,
        },
        savedAt: "2026-06-22T00:00:08.000Z",
      },
    ]);
    const rejectedSnapshot = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig,
      offline: true,
      snapshotStore: unsignedSnapshot,
    });

    expect(rejectedSnapshot.source).toBe("bundled-fallback");
    if (rejectedSnapshot.source === "bundled-fallback") {
      expect(rejectedSnapshot.error).toContain("signed envelope is malformed");
    }
  });

  it.each([
    [
      "off-allowlist hosts",
      "https://packages.acme.example/openclaw/feed",
      "hostname is not allowed",
    ],
    [
      "credential-bearing URLs",
      "https://user:test-auth-token@clawhub.ai/v1/feeds/plugins",
      "must not include credentials",
    ],
    [
      "query-bearing URLs",
      "https://clawhub.ai/v1/feeds/plugins?query=test-value",
      "must not include query strings or fragments",
    ],
    [
      "fragment-bearing URLs",
      "https://clawhub.ai/v1/feeds/plugins#fragment",
      "must not include query strings or fragments",
    ],
  ])("rejects direct hosted feed overrides with %s", async (_label, feedUrl, expectedError) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await loadHostedCatalog({ feedUrl, fetchImpl, snapshotStore: null });

    expect(result.source).toBe("bundled-fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain(expectedError);
    }
  });

  it("preserves signed profile verification for direct feed URL overrides", async () => {
    const signed = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/signed-override" }),
    });
    const unsignedBody = JSON.stringify(
      hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/unsigned-override" }),
    );
    const result = await loadHostedCatalog({
      feedProfile: "acme",
      feedUrl: "https://clawhub.ai/v1/feeds/plugins",
      catalogConfig: signedCatalogConfig(signed.publicKeyPem),
      fetchImpl: vi.fn(async () => new Response(unsignedBody, { status: 200 })),
      snapshotStore: null,
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("signed envelope is malformed");
    }
  });

  it("filters hosted entries that reference unknown source profiles", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:10.000Z",
      sequence: 10,
      entries: [
        {
          name: "@acme/known-source",
          kind: "plugin",
          openclaw: {
            plugin: { id: "known-source" },
            install: { sourceRef: "acme-npm", npmSpec: "@acme/known-source" },
          },
        },
        {
          name: "@acme/unknown-source",
          kind: "plugin",
          openclaw: {
            plugin: { id: "unknown-source" },
            install: { sourceRef: "attacker-npm", npmSpec: "@acme/unknown-source" },
          },
        },
      ],
    });
    const result = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig: {
        feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
        sources: {
          "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
        },
      },
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@acme/known-source"]);
  });

  it("enforces hosted checksum and response-size limits", async () => {
    const validBody = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:01.000Z",
      sequence: 1,
      entries: [],
    });
    const mismatch = await loadHostedCatalog({
      expectedSha256: "sha256:not-current",
      fetchImpl: vi.fn(async () => new Response(validBody, { status: 200 })),
      snapshotStore: null,
    });

    expect(mismatch.source).toBe("bundled-fallback");
    if (mismatch.source === "bundled-fallback") {
      expect(mismatch.error).toContain("checksum mismatch");
      expect(mismatch.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }

    const oversized = await loadHostedCatalog({
      maxBytes: 4,
      fetchImpl: vi.fn(async () => new Response("12345", { status: 200 })),
      snapshotStore: null,
    });
    expect(oversized.source).toBe("bundled-fallback");
    if (oversized.source === "bundled-fallback") {
      expect(oversized.error).toContain("exceeds 4 bytes");
    }

    const response = new Response("x".repeat(8192), {
      status: 200,
      headers: { "content-length": "1" },
    });
    Object.defineProperty(response, "body", { value: null });
    const arrayBuffer = vi.fn(response.arrayBuffer.bind(response));
    Object.defineProperty(response, "arrayBuffer", { value: arrayBuffer });
    const nonStreaming = await loadHostedCatalog({
      maxBytes: 4096,
      fetchImpl: vi.fn(async () => response),
      snapshotStore: null,
    });

    expect(nonStreaming.source).toBe("bundled-fallback");
    if (nonStreaming.source === "bundled-fallback") {
      expect(nonStreaming.error).toContain("streaming response body unavailable");
    }
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("reuses a validated snapshot for matching HTTP 304 validators", async () => {
    const snapshotStore = createInMemoryHostedCatalogSnapshotStore();
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:01.000Z",
      sequence: 1,
      entries: [],
    });
    const seeded = await loadHostedCatalog({
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { etag: '"snapshot-v1"' },
          }),
      ),
      now: () => new Date("2026-06-22T00:00:01.000Z"),
      snapshotStore,
    });
    expect(seeded.source).toBe("hosted");

    const reused = await loadHostedCatalog({
      ifNoneMatch: '"snapshot-v1"',
      fetchImpl: vi.fn(
        async () => new Response(null, { status: 304, headers: { etag: '"snapshot-v1"' } }),
      ),
      snapshotStore,
    });
    expect(reused.source).toBe("hosted-snapshot");
    if (reused.source === "hosted-snapshot") {
      expect(reused.snapshot.savedAt).toBe("2026-06-22T00:00:01.000Z");
    }
  });

  it("prefers feed install candidates before legacy install metadata", () => {
    expect(
      resolveOfficialExternalPluginInstall({
        name: "@legacy/plain-package",
        kind: "plugin",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
        install: {
          candidates: [
            {
              sourceRef: "public-clawhub",
              package: "@openclaw/candidate-package",
              version: "1.2.3",
              integrity: "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
            },
          ],
        },
        openclaw: {
          plugin: { id: "candidate-package" },
          install: {
            npmSpec: "@legacy/plain-package",
            minHostVersion: ">=2026.6.1",
            expectedIntegrity: "sha256:manifest",
            allowInvalidConfigRecovery: true,
          },
        },
      }),
    ).toEqual({
      clawhubSpec: "clawhub:@openclaw/candidate-package@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
      minHostVersion: ">=2026.6.1",
      allowInvalidConfigRecovery: true,
    });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "@acme/private-package",
          kind: "plugin",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              { sourceRef: "acme-npm", package: "@acme/private-package", version: "4.5.6" },
            ],
          },
        },
        { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
      ),
    ).toEqual({
      npmSpec: "@acme/private-package@4.5.6",
      defaultChoice: "npm",
    });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "@acme/private-sha-package",
          kind: "plugin",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "acme-npm",
                package: "@acme/private-sha-package",
                version: "4.5.6",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
        { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
      ),
    ).toEqual({ npmSpec: "@acme/private-sha-package@4.5.6", defaultChoice: "npm" });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "@acme/private-sri-package",
          kind: "plugin",
          state: "available",
          publisher: { id: "acme", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "acme-npm",
                package: "@acme/private-sri-package",
                version: "4.5.6",
                integrity: "sha512-abc=",
              },
            ],
          },
        },
        { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
      ),
    ).toEqual({
      npmSpec: "@acme/private-sri-package@4.5.6",
      defaultChoice: "npm",
      expectedIntegrity: "sha512-abc=",
    });

    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "git-only-package",
          kind: "plugin",
          install: {
            candidates: [{ sourceRef: "acme-git", package: "git@example.com:acme/plugin.git" }],
          },
        },
        { catalogConfig: { sources: { "acme-git": { type: "git" } } } },
      ),
    ).toBeNull();

    expect(
      resolveOfficialExternalPluginInstall({ id: "metadata-only", title: "Metadata only" }),
    ).toBeNull();
  });

  it("lists the externalized provider and capability plugins with install metadata", () => {
    const providers = [
      ["arcee", "@openclaw/arcee-provider"],
      ["cerebras", "@openclaw/cerebras-provider"],
      ["chutes", "@openclaw/chutes-provider"],
      ["cloudflare-ai-gateway", "@openclaw/cloudflare-ai-gateway-provider"],
      ["deepinfra", "@openclaw/deepinfra-provider"],
      ["deepseek", "@openclaw/deepseek-provider"],
      ["groq", "@openclaw/groq-provider"],
      ["longcat", "@openclaw/longcat-provider"],
      ["kilocode", "@openclaw/kilocode-provider"],
      ["kimi", "@openclaw/kimi-provider"],
      ["qianfan", "@openclaw/qianfan-provider"],
      ["qwen", "@openclaw/qwen-provider"],
    ] as const;
    const plugins = [
      ["exa", "@openclaw/exa-plugin"],
      ["firecrawl", "@openclaw/firecrawl-plugin"],
      ["gradium", "@openclaw/gradium-speech"],
      ["inworld", "@openclaw/inworld-speech"],
      ["parallel", "@openclaw/parallel-plugin"],
      ["perplexity", "@openclaw/perplexity-plugin"],
    ] as const;
    const newlyExternalized = [
      ["clickclack", "@openclaw/clickclack"],
      ["fireworks", "@openclaw/fireworks-provider"],
      ["irc", "@openclaw/irc"],
      ["mattermost", "@openclaw/mattermost"],
      ["moonshot", "@openclaw/moonshot-provider"],
      ["searxng", "@openclaw/searxng-plugin"],
      ["signal", "@openclaw/signal"],
      ["sms", "@openclaw/sms"],
      ["tavily", "@openclaw/tavily-plugin"],
      ["tencent", "@openclaw/tencent-provider"],
      ["venice", "@openclaw/venice-provider"],
      ["vercel-ai-gateway", "@openclaw/vercel-ai-gateway-provider"],
      ["zai", "@openclaw/zai-provider"],
    ] as const;
    const currentExternalized = [["featherless", "@openclaw/featherless-provider"]] as const;

    for (const [id, npmSpec] of [...providers, ...plugins]) {
      expect(resolveOfficialExternalPluginInstall(expectCatalogEntry(id))).toEqual({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.8",
      });
    }
    for (const [id, npmSpec] of newlyExternalized) {
      expect(resolveOfficialExternalPluginInstall(expectCatalogEntry(id))).toMatchObject({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.9",
      });
    }
    for (const [id, npmSpec] of currentExternalized) {
      expect(resolveOfficialExternalPluginInstall(expectCatalogEntry(id))).toEqual({
        clawhubSpec: `clawhub:${npmSpec}`,
        npmSpec,
        defaultChoice: "npm",
        minHostVersion: ">=2026.6.11",
      });
    }
  });

  it("advertises StepFun with its ClawHub package and plugin API floor", () => {
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("stepfun"))).toEqual({
      clawhubSpec: "clawhub:@openclaw/stepfun-provider",
      npmSpec: "@openclaw/stepfun-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.9",
    });
  });

  it("resolves third-party channel lookup aliases to published plugin ids", () => {
    const wecomByChannel = expectCatalogEntry("wecom");
    const wecomByPlugin = expectCatalogEntry("wecom-openclaw-plugin");
    const yuanbaoByChannel = expectCatalogEntry("yuanbao");

    expect(resolveOfficialExternalPluginId(wecomByChannel)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginId(wecomByPlugin)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginInstall(wecomByChannel)?.npmSpec).toBe(
      "@wecom/wecom-openclaw-plugin@2026.5.7",
    );
    expect(resolveOfficialExternalPluginId(yuanbaoByChannel)).toBe("openclaw-plugin-yuanbao");
    expect(resolveOfficialExternalPluginInstall(yuanbaoByChannel)?.npmSpec).toBe(
      "openclaw-plugin-yuanbao@2.15.0",
    );
  });

  it("keeps official launch package specs on the production package names", () => {
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("acpx"))?.npmSpec).toBe(
      "@openclaw/acpx",
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("googlechat"))?.npmSpec).toBe(
      "@openclaw/googlechat",
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("line"))?.npmSpec).toBe(
      "@openclaw/line",
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("diffs-language-pack"))).toEqual(
      {
        npmSpec: "@openclaw/diffs-language-pack",
        clawhubSpec: "clawhub:@openclaw/diffs-language-pack",
        defaultChoice: "npm",
        minHostVersion: ">=2026.5.27",
      },
    );
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("llama-cpp"))?.npmSpec).toBe(
      "@openclaw/llama-cpp-provider",
    );
  });

  it("lists GMI Cloud as an official external provider", () => {
    const gmi = expectCatalogEntry("gmi");

    expect(resolveOfficialExternalPluginId(gmi)).toBe("gmi");
    expect(getOfficialExternalPluginCatalogEntry("gmi-cloud")).toBe(gmi);
    expect(resolveOfficialExternalPluginInstall(gmi)).toEqual({
      clawhubSpec: "clawhub:@openclaw/gmi-provider",
      npmSpec: "@openclaw/gmi-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.8",
    });
  });

  it("lists Cohere as an official external provider", () => {
    const cohere = expectCatalogEntry("cohere");

    expect(resolveOfficialExternalPluginId(cohere)).toBe("cohere");
    expect(resolveOfficialExternalPluginInstall(cohere)).toEqual({
      clawhubSpec: "clawhub:@openclaw/cohere-provider",
      npmSpec: "@openclaw/cohere-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.8",
    });
  });

  it("lists LongCat as an official external provider", () => {
    const longcat = expectCatalogEntry("longcat");

    expect(resolveOfficialExternalPluginId(longcat)).toBe("longcat");
    expect(getOfficialExternalPluginCatalogEntry("meituan-longcat")).toBe(longcat);
    expect(resolveOfficialExternalPluginInstall(longcat)).toEqual({
      clawhubSpec: "clawhub:@openclaw/longcat-provider",
      npmSpec: "@openclaw/longcat-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.6.8",
    });
  });

  it("resolves external provider aliases beyond the primary provider id", () => {
    const qwen = expectCatalogEntry("qwen");

    expect(getOfficialExternalPluginCatalogEntry("modelstudio")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-oauth")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-portal")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("qwen-token-plan")).toBe(qwen);
    expect(getOfficialExternalPluginCatalogEntry("bailian-token-plan")).toBe(qwen);
  });

  it("maps external speech and web-fetch contracts to plugin owners", () => {
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "speechProviders",
        providerIds: new Set(["gradium", "inworld"]),
      }),
    ).toEqual(["gradium", "inworld"]);
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "webFetchProviders",
        providerIds: new Set(["firecrawl"]),
      }),
    ).toEqual(["firecrawl"]);
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "mediaUnderstandingProviders",
        providerIds: new Set(["groq", "moonshot", "zai"]),
      }),
    ).toEqual(["groq", "moonshot", "zai"]);
  });

  it("maps env-only web-fetch credentials to external plugin owners", () => {
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { FIRECRAWL_API_KEY: "firecrawl-key" },
      }),
    ).toEqual(["firecrawl"]);
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { EXA_API_KEY: "exa-key" },
      }),
    ).toEqual([]);
  });

  it("maps configured provider ids and aliases even without an auth choice", () => {
    expect(
      resolveOfficialExternalProviderPluginIds({
        providerIds: new Set(["groq", "modelstudio"]),
      }),
    ).toEqual(["groq", "qwen"]);
  });

  it("maps env-only provider credentials to external installs", () => {
    expect(
      resolveOfficialExternalProviderPluginIdsForEnv({
        ARCEEAI_API_KEY: "arcee-key",
        CEREBRAS_API_KEY: "cerebras-key",
        CHUTES_OAUTH_TOKEN: "chutes-token",
        CLOUDFLARE_AI_GATEWAY_API_KEY: "cloudflare-key",
        DEEPINFRA_API_KEY: "deepinfra-key",
        DEEPSEEK_API_KEY: "deepseek-key",
        FEATHERLESS_API_KEY: "featherless-key",
        GROQ_API_KEY: "groq-key",
        LONGCAT_API_KEY: "longcat-key",
        KILOCODE_API_KEY: "kilocode-key",
        KIMICODE_API_KEY: "kimi-key",
        KIMI_API_KEY: "moonshot-kimi-key",
        MOONSHOT_API_KEY: "moonshot-key",
        QIANFAN_API_KEY: "qianfan-key",
        MODELSTUDIO_API_KEY: "qwen-key",
        STEPFUN_API_KEY: "stepfun-key",
        FIREWORKS_API_KEY: "fireworks-key",
        TOKENHUB_API_KEY: "tokenhub-key",
        TOKENPLAN_API_KEY: "tokenplan-key",
        VENICE_API_KEY: "venice-key",
        AI_GATEWAY_API_KEY: "gateway-key",
        ZAI_API_KEY: "zai-key",
      }),
    ).toEqual([
      "arcee",
      "cerebras",
      "chutes",
      "cloudflare-ai-gateway",
      "deepinfra",
      "deepseek",
      "featherless",
      "fireworks",
      "groq",
      "kilocode",
      "kimi",
      "longcat",
      "moonshot",
      "qianfan",
      "qwen",
      "stepfun",
      "tencent",
      "venice",
      "vercel-ai-gateway",
      "zai",
    ]);
    expect(resolveOfficialExternalProviderPluginIdsForEnv({ GROQ_API_KEY: " " })).toEqual([]);
    expect(resolveOfficialExternalProviderPluginIdsForEnv({ LONGCAT_API_KEY: " " })).toEqual([]);
  });

  it("keeps Tencent auth choices available through the cold-install auth catalog", () => {
    const tencent = expectCatalogEntry("tencent");
    const tokenHub = tencent.openclaw?.providers?.find(
      (provider) => provider.id === "tencent-tokenhub",
    );
    const tokenPlan = tencent.openclaw?.providers?.find(
      (provider) => provider.id === "tencent-tokenplan",
    );

    expect(tokenHub?.envVars).toEqual(["TOKENHUB_API_KEY"]);
    expect(tokenHub?.authChoices).toEqual([
      expect.objectContaining({
        choiceId: "tokenhub-api-key",
        optionKey: "tokenhubApiKey",
        cliFlag: "--tokenhub-api-key",
      }),
    ]);
    expect(tokenPlan?.envVars).toEqual(["TOKENPLAN_API_KEY"]);
    expect(tokenPlan?.authChoices?.[0]).toMatchObject({
      choiceId: "tokenplan-api-key",
      optionKey: "tokenplanApiKey",
      cliFlag: "--tokenplan-api-key",
    });
  });

  it("keeps Groq available through the cold-install auth catalog", () => {
    const groq = expectCatalogEntry("groq");
    const authChoice = groq.openclaw?.providers?.find((provider) => provider.id === "groq")
      ?.authChoices?.[0];

    expect(authChoice).toMatchObject({
      choiceId: "groq-api-key",
      optionKey: "groqApiKey",
      cliFlag: "--groq-api-key",
      cliOption: "--groq-api-key <key>",
    });
  });

  it("allows invalid-config recovery for externalized stock plugins", () => {
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("brave"))).toMatchObject({
      npmSpec: "@openclaw/brave-plugin",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("slack"))).toMatchObject({
      npmSpec: "@openclaw/slack",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("discord"))).toMatchObject({
      npmSpec: "@openclaw/discord",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("mattermost"))).toMatchObject({
      npmSpec: "@openclaw/mattermost",
      allowInvalidConfigRecovery: true,
    });
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("tavily"))).toMatchObject({
      npmSpec: "@openclaw/tavily-plugin",
      allowInvalidConfigRecovery: true,
    });
  });

  it("lists Matrix as an official external ClawHub channel after cutover", () => {
    const ids = new Set<string>();
    for (const entry of listOfficialExternalPluginCatalogEntries()) {
      const pluginId = resolveOfficialExternalPluginId(entry);
      if (pluginId) {
        ids.add(pluginId);
      }
    }

    expect(ids.has("matrix")).toBe(true);
    expect(ids.has("mattermost")).toBe(true);
    expect(resolveOfficialExternalPluginInstall(expectCatalogEntry("matrix"))).toEqual({
      clawhubSpec: "clawhub:@openclaw/matrix",
      npmSpec: "@openclaw/matrix",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.4.10",
      allowInvalidConfigRecovery: true,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
