import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE,
  createOfficialExternalPluginCatalogEnvelopePayload,
  createOfficialExternalPluginCatalogEnvelopeSigningInput,
  type OfficialExternalPluginCatalogSignedEnvelope,
} from "./official-external-plugin-catalog-envelope.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import {
  type OfficialExternalPluginCatalogEntry,
  DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL,
  createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore,
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  isOfficialExternalPluginCatalogFeed,
  filterOfficialExternalPluginCatalogEntriesBySourceRefs,
  listOfficialExternalPluginCatalogEntries,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  loadHostedOfficialExternalPluginCatalogEntries,
  parseOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginCatalogProfileConfigFromConfig,
  validateOfficialExternalPluginCatalogEntrySourceRefs,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

function expectCatalogEntry(id: string): OfficialExternalPluginCatalogEntry {
  const entry = getOfficialExternalPluginCatalogEntry(id);
  if (entry === undefined) {
    throw new Error(`Expected external plugin catalog entry for ${id}`);
  }
  return entry;
}

function expectRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function signedHostedCatalogFeed(params?: {
  feed?: OfficialExternalPluginCatalogFeed;
  keyId?: string;
  privateKeyPem?: string;
}): {
  body: string;
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } =
    params?.privateKeyPem === undefined
      ? crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
      : {
          publicKey: crypto
            .createPublicKey(params.privateKeyPem)
            .export({ type: "spki", format: "pem" }) as string,
          privateKey: params.privateKeyPem,
        };
  const payload = createOfficialExternalPluginCatalogEnvelopePayload(
    params?.feed ?? {
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 8,
      entries: [
        {
          name: "@openclaw/signed-refresh-proof",
          kind: "plugin",
          openclaw: {
            plugin: { id: "signed-refresh-proof" },
            install: { sourceRef: "acme-npm", npmSpec: "@openclaw/signed-refresh-proof" },
          },
        },
      ],
    },
  );
  const signingInput = createOfficialExternalPluginCatalogEnvelopeSigningInput({
    payloadType: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE,
    payloadBytes: Buffer.from(payload, "base64"),
  });
  const envelope: OfficialExternalPluginCatalogSignedEnvelope = {
    schemaVersion: 1,
    payloadType: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE,
    payload,
    signatures: [
      {
        keyId: params?.keyId ?? "acme-root",
        algorithm: "ed25519",
        signature: crypto
          .sign(null, signingInput, crypto.createPrivateKey(privateKey))
          .toString("base64url"),
      },
    ],
  };
  return {
    body: JSON.stringify(envelope),
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
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

  it("accepts live ClawHub marketplace entries with trusted install candidates", () => {
    const [entry] = parseOfficialExternalPluginCatalogEntries({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          type: "plugin",
          id: "@expediagroup/expedia-openclaw",
          title: "Expedia Travel",
          version: "1.0.4",
          state: "available",
          publisher: {
            id: "expediagroup",
            trust: "official",
          },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@expediagroup/expedia-openclaw",
                version: "1.0.4",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
      ],
    });

    if (entry === undefined) {
      throw new Error("Expected hosted ClawHub feed entry to parse");
    }

    expect(entry).toMatchObject({
      id: "@expediagroup/expedia-openclaw",
      title: "Expedia Travel",
      version: "1.0.4",
    });
    expect(resolveOfficialExternalPluginId(entry)).toBe("@expediagroup/expedia-openclaw");
    expect(resolveOfficialExternalPluginInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@expediagroup/expedia-openclaw@1.0.4",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
    });
  });

  it("does not synthesize trusted installs for unavailable or untrusted hosted entries", () => {
    const entries = parseOfficialExternalPluginCatalogEntries({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          type: "plugin",
          id: "@example/unavailable",
          title: "Unavailable",
          version: "1.0.0",
          state: "disabled",
          publisher: { id: "example", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/unavailable",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/community",
          title: "Community",
          version: "1.0.0",
          state: "available",
          publisher: { id: "example", trust: "community" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/community",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/missing-state",
          title: "Missing State",
          version: "1.0.0",
          publisher: { id: "example", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/missing-state",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/missing-trust",
          title: "Missing Trust",
          version: "1.0.0",
          state: "available",
          publisher: { id: "example" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/missing-trust",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/missing-publisher",
          title: "Missing Publisher",
          version: "1.0.0",
          state: "available",
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@example/missing-publisher",
                version: "1.0.0",
              },
            ],
          },
        },
        {
          type: "plugin",
          id: "@example/private-source",
          title: "Private Source",
          version: "1.0.0",
          state: "available",
          publisher: { id: "example", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "private-feed",
                package: "@example/private-source",
                version: "1.0.0",
              },
            ],
          },
        },
      ],
    });

    expect(entries).toHaveLength(6);
    for (const entry of entries) {
      expect(resolveOfficialExternalPluginId(entry)).toBe(entry.id);
      expect(resolveOfficialExternalPluginInstall(entry)).toBeNull();
    }
  });

  it("keeps unsupported versioned feed wrappers out of legacy catalog parsing", () => {
    expect(
      parseOfficialExternalPluginCatalogEntries({
        schemaVersion: 3,
        id: "future-feed",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 1,
        entries: [{ name: "should-not-load" }],
      }),
    ).toEqual([]);
    expect(
      parseOfficialExternalPluginCatalogEntries({
        entries: [{ name: "legacy-catalog-entry" }],
      }),
    ).toEqual([{ name: "legacy-catalog-entry" }]);
  });

  it("loads a hosted feed with conditional headers and checksum metadata", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 2,
      entries: [
        {
          name: "@openclaw/hosted-proof",
          kind: "plugin",
          openclaw: {
            plugin: { id: "hosted-proof", label: "Hosted Proof" },
            install: { npmSpec: "@openclaw/hosted-proof", defaultChoice: "npm" },
          },
        },
      ],
    });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"old"');
      expect(headers.get("if-modified-since")).toBe("Mon, 22 Jun 2026 00:00:00 GMT");
      return new Response(body, {
        status: 200,
        headers: {
          etag: '"next"',
          "last-modified": "Mon, 22 Jun 2026 01:00:00 GMT",
          "content-length": String(new TextEncoder().encode(body).byteLength),
        },
      });
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl,
      ifNoneMatch: '"old"',
      ifModifiedSince: "Mon, 22 Jun 2026 00:00:00 GMT",
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/hosted-proof"]);
    if (result.source === "hosted") {
      expect(result.feed.sequence).toBe(2);
      expect(result.metadata).toMatchObject({
        status: 200,
        etag: '"next"',
        lastModified: "Mon, 22 Jun 2026 01:00:00 GMT",
      });
      expect(result.metadata.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("keeps live ClawHub metadata-only entries after hosted feed loading", async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          type: "plugin",
          id: "@expediagroup/expedia-openclaw",
          title: "Expedia Travel",
          version: "1.0.4",
          state: "available",
          publisher: {
            id: "expediagroup",
            trust: "official",
          },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@expediagroup/expedia-openclaw",
                version: "1.0.4",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
      ],
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: {
              "content-length": String(new TextEncoder().encode(body).byteLength),
            },
          }),
      ),
    });

    expect(result.source).toBe("hosted");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: "@expediagroup/expedia-openclaw",
      title: "Expedia Travel",
      version: "1.0.4",
    });
  });

  it("uses the default local feed profile for hosted catalog loading", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 8,
      entries: [
        {
          name: "@openclaw/default-profile-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "default-profile-proof" } },
        },
      ],
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(expectRequestUrl(url)).toBe(DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL);
      return new Response(body, { status: 200 });
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "clawhub-public",
      catalogConfig: {
        sources: { "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" } },
      },
      fetchImpl,
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/default-profile-proof"]);
  });

  it("accepts the live ClawHub feed source ref by default", async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-23T09:38:53.000Z",
      sequence: 4,
      entries: [
        {
          type: "plugin",
          id: "@openclaw/live-feed-proof",
          title: "Live Feed Proof",
          version: "1.0.0",
          state: "available",
          publisher: { id: "openclaw", trust: "official" },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@openclaw/live-feed-proof",
                version: "1.0.0",
                integrity:
                  "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
              },
            ],
          },
        },
      ],
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        expect(expectRequestUrl(url)).toBe(DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL);
        return new Response(body, { status: 200 });
      }),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.id)).toEqual(["@openclaw/live-feed-proof"]);
    expect(
      resolveOfficialExternalPluginInstall(
        expectDefined(result.entries[0], "result.entries[0] test invariant"),
      ),
    ).toEqual({
      clawhubSpec: "clawhub:@openclaw/live-feed-proof@1.0.0",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
    });
  });

  it("loads hosted catalog profiles from OpenClaw config", async () => {
    const config = {
      marketplaces: {
        feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
        sources: { "acme-npm": { type: "npm" as const } },
      },
    };
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 14,
      entries: [
        {
          name: "@acme/config-profile-proof",
          kind: "plugin",
          openclaw: {
            plugin: { id: "config-profile-proof" },
            install: { sourceRef: "acme-npm", npmSpec: "@acme/config-profile-proof" },
          },
        },
      ],
    });

    expect(resolveOfficialExternalPluginCatalogProfileConfigFromConfig(config)).toBe(
      config.marketplaces,
    );

    const result = await loadConfiguredHostedOfficialExternalPluginCatalogEntries(config, {
      feedProfile: "acme",
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        expect(expectRequestUrl(url)).toBe("https://packages.acme.example/openclaw/feed");
        return new Response(body, { status: 200 });
      }),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@acme/config-profile-proof"]);
  });

  it("allows named local feed profiles to authorize their configured HTTPS host", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 9,
      entries: [
        {
          name: "@acme/private-proof",
          kind: "plugin",
          install: {
            candidates: [
              {
                sourceRef: "acme-npm",
                package: "@acme/private-proof",
                version: "1.0.0",
              },
            ],
          },
          openclaw: {
            plugin: { id: "private-proof" },
            install: { sourceRef: "acme-npm", npmSpec: "@acme/private-proof" },
          },
        },
      ],
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(expectRequestUrl(url)).toBe("https://packages.acme.example/openclaw/feed");
      return new Response(body, { status: 200 });
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig: {
        feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
        sources: { "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" } },
      },
      fetchImpl,
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@acme/private-proof"]);
  });

  it("loads and snapshots a signed hosted feed profile after envelope verification", async () => {
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore();
    const writeSpy = vi.spyOn(snapshotStore, "write");
    const signed = signedHostedCatalogFeed();

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig: {
        feeds: {
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: {
              mode: "signed",
              keys: [
                {
                  keyId: "acme-root",
                  publicKey: signed.publicKeyPem,
                },
              ],
            },
          },
        },
        sources: { "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" } },
      },
      fetchImpl: vi.fn(async () => new Response(signed.body, { status: 200 })),
      now: () => new Date("2026-06-22T04:05:06.000Z"),
      snapshotStore,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-refresh-proof"]);
    if (result.source === "hosted") {
      expect(result.trust).toEqual({
        mode: "signed",
        signedBy: "acme-root",
        signatureCount: 1,
        threshold: 1,
        verifiedAt: "2026-06-22T04:05:06.000Z",
      });
    }
    expect(writeSpy).toHaveBeenCalledTimes(1);
    await expect(
      snapshotStore.read("https://packages.acme.example/openclaw/feed"),
    ).resolves.toMatchObject({
      body: signed.body,
      trust: {
        mode: "signed",
        signedBy: "acme-root",
        signatureCount: 1,
        threshold: 1,
        verifiedAt: "2026-06-22T04:05:06.000Z",
      },
    });
  });

  it("rejects signed hosted feed rollback before replacing snapshots", async () => {
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore();
    const newer = signedHostedCatalogFeed({
      feed: {
        schemaVersion: 1,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:10.000Z",
        sequence: 10,
        entries: [
          {
            name: "@openclaw/signed-refresh-proof-v10",
            kind: "plugin",
            openclaw: {
              plugin: { id: "signed-refresh-proof-v10" },
              install: { sourceRef: "acme-npm", npmSpec: "@openclaw/signed-refresh-proof-v10" },
            },
          },
        ],
      },
    });
    const older = signedHostedCatalogFeed({
      privateKeyPem: newer.privateKeyPem,
      feed: {
        schemaVersion: 1,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:09.000Z",
        sequence: 9,
        entries: [
          {
            name: "@openclaw/signed-refresh-proof-v9",
            kind: "plugin",
            openclaw: {
              plugin: { id: "signed-refresh-proof-v9" },
              install: { sourceRef: "acme-npm", npmSpec: "@openclaw/signed-refresh-proof-v9" },
            },
          },
        ],
      },
    });
    const catalogConfig = {
      feeds: {
        acme: {
          url: "https://packages.acme.example/openclaw/feed",
          verification: {
            mode: "signed" as const,
            keys: [{ keyId: "acme-root", publicKey: newer.publicKeyPem }],
          },
        },
      },
      sources: {
        "acme-npm": { type: "npm" as const, registry: "https://packages.acme.example/npm/" },
      },
    };

    await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () => new Response(newer.body, { status: 200 })),
      snapshotStore,
    });
    const writeSpy = vi.spyOn(snapshotStore, "write");

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () => new Response(older.body, { status: 200 })),
      snapshotStore,
    });

    expect(result.source).toBe("hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@openclaw/signed-refresh-proof-v10",
    ]);
    if (result.source === "hosted-snapshot") {
      expect(result.error).toContain("signed feed sequence is older");
      expect(result.feed.sequence).toBe(10);
    }
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("keeps signed SQLite snapshot replacement monotonic under concurrent writes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-signed-snapshot-race-"));
    const url = "https://packages.acme.example/openclaw/feed";
    const newer = signedHostedCatalogFeed({
      feed: {
        schemaVersion: 1,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:10.000Z",
        sequence: 10,
        entries: [
          {
            name: "@openclaw/signed-refresh-proof-v10",
            kind: "plugin",
            openclaw: { plugin: { id: "signed-refresh-proof-v10" } },
          },
        ],
      },
    });
    const older = signedHostedCatalogFeed({
      privateKeyPem: newer.privateKeyPem,
      feed: {
        schemaVersion: 1,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:09.000Z",
        sequence: 9,
        entries: [
          {
            name: "@openclaw/signed-refresh-proof-v9",
            kind: "plugin",
            openclaw: { plugin: { id: "signed-refresh-proof-v9" } },
          },
        ],
      },
    });
    const snapshotStore = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({
      stateDir: tempDir,
    });
    const trust = {
      mode: "signed" as const,
      signedBy: "acme-root",
      signatureCount: 1,
      threshold: 1,
      verifiedAt: "2026-06-22T04:05:06.000Z",
    };
    const snapshotFor = (body: string, sequence: number, generatedAt: string) => ({
      body,
      metadata: {
        url,
        status: 200,
        checksum: "sha256:" + crypto.createHash("sha256").update(body).digest("hex"),
      },
      savedAt: "2026-06-22T04:05:06.000Z",
      trust,
      monotonic: { mode: "signed-feed" as const, sequence, generatedAt },
    });

    try {
      await Promise.allSettled([
        snapshotStore.write(snapshotFor(older.body, 9, "2026-06-22T00:00:09.000Z")),
        snapshotStore.write(snapshotFor(newer.body, 10, "2026-06-22T00:00:10.000Z")),
      ]);

      const snapshot = await snapshotStore.read(url);
      expect(snapshot?.body).toBe(newer.body);
      expect(snapshot?.trust).toMatchObject(trust);
    } finally {
      closeOpenClawStateDatabaseForTest();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a signed feed profile receives unsigned JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            id: "openclaw-official-external-plugins",
            generatedAt: "2026-06-22T00:00:00.000Z",
            sequence: 8,
            entries: [],
          }),
          { status: 200 },
        ),
    );

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig: {
        feeds: {
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: {
              mode: "signed",
              keys: [
                {
                  keyId: "acme-root",
                  publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              ],
            },
          },
        },
      },
      fetchImpl,
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("bundled-fallback");
    expect(result.entries).toEqual([]);
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("signed envelope is malformed");
    }
  });

  it("preserves signed feed profile verification for direct URL overrides", async () => {
    const signed = signedHostedCatalogFeed();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            id: "openclaw-official-external-plugins",
            generatedAt: "2026-06-22T00:00:00.000Z",
            sequence: 8,
            entries: [],
          }),
          { status: 200 },
        ),
    );

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      feedUrl: "https://clawhub.ai/v1/feeds/plugins",
      catalogConfig: {
        feeds: {
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: {
              mode: "signed",
              keys: [{ keyId: "acme-root", publicKey: signed.publicKeyPem }],
            },
          },
        },
      },
      fetchImpl,
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("bundled-fallback");
    expect(result.entries).toEqual([]);
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("signed envelope is malformed");
    }
  });

  it("keeps direct hosted feed URL overrides constrained to the public allowlist", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedUrl: "https://packages.acme.example/openclaw/feed",
      fetchImpl,
      snapshotStore: null,
    });

    expect(result.source).toBe("bundled-fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("hostname is not allowed");
    }
  });

  it("rejects credential-bearing direct hosted feed URL overrides", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedUrl: "https://user:secret@clawhub.ai/v1/feeds/plugins",
      fetchImpl,
      snapshotStore: null,
    });

    expect(result.source).toBe("bundled-fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("must not include credentials");
    }
  });

  it("rejects query or fragment-bearing direct hosted feed URL overrides", async () => {
    for (const feedUrl of [
      "https://clawhub.ai/v1/feeds/plugins?token=secret",
      "https://clawhub.ai/v1/feeds/plugins#fragment",
    ]) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

      const result = await loadHostedOfficialExternalPluginCatalogEntries({
        feedUrl,
        fetchImpl,
        snapshotStore: null,
      });

      expect(result.source).toBe("bundled-fallback");
      expect(fetchImpl).not.toHaveBeenCalled();
      if (result.source === "bundled-fallback") {
        expect(result.error).toContain("must not include query strings or fragments");
      }
    }
  });

  it("requires manifest install source refs when the default feed profile URL is overridden", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 13,
      entries: [
        {
          name: "@acme/default-override-missing-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "default-override-missing-source-ref" },
            install: { npmSpec: "@acme/default-override-missing-source-ref" },
          },
        },
        {
          name: "@acme/default-override-known-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "default-override-known-source-ref" },
            install: { sourceRef: "acme-npm", npmSpec: "@acme/default-override-known-source-ref" },
          },
        },
      ],
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      catalogConfig: {
        feeds: { "clawhub-public": { url: "https://packages.acme.example/openclaw/feed" } },
        sources: { "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" } },
      },
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        expect(expectRequestUrl(url)).toBe("https://packages.acme.example/openclaw/feed");
        return new Response(body, { status: 200 });
      }),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@acme/default-override-known-source-ref",
    ]);
  });

  it("preserves default feed manifest installs for direct default hosted feed URL refreshes", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 14,
      entries: [
        {
          name: "@openclaw/direct-default-missing-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "direct-default-missing-source-ref" },
            install: { npmSpec: "@openclaw/direct-default-missing-source-ref" },
          },
        },
      ],
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins",
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        expect(expectRequestUrl(url)).toBe("https://clawhub.ai/v1/feeds/plugins");
        return new Response(body, { status: 200 });
      }),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@openclaw/direct-default-missing-source-ref",
    ]);
  });

  it("requires manifest install source refs for non-default direct hosted feed URL overrides", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 15,
      entries: [
        {
          name: "@acme/direct-url-missing-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "direct-url-missing-source-ref" },
            install: { npmSpec: "@acme/direct-url-missing-source-ref" },
          },
        },
        {
          name: "@acme/direct-url-known-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "direct-url-known-source-ref" },
            install: { sourceRef: "acme-npm", npmSpec: "@acme/direct-url-known-source-ref" },
          },
        },
      ],
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedUrl: "https://clawhub.ai/v1/feeds/acme",
      catalogConfig: {
        sources: { "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" } },
      },
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        expect(expectRequestUrl(url)).toBe("https://clawhub.ai/v1/feeds/acme");
        return new Response(body, { status: 200 });
      }),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@acme/direct-url-known-source-ref",
    ]);
  });

  it("requires manifest install source refs for custom local feed profiles", async () => {
    const missingManifestSourceRef = {
      name: "@acme/missing-manifest-source-ref",
      kind: "plugin",
      openclaw: {
        plugin: { id: "missing-manifest-source-ref" },
        install: { npmSpec: "@acme/missing-manifest-source-ref" },
      },
    };
    const knownManifestSourceRef = {
      name: "@acme/known-manifest-source-ref",
      kind: "plugin",
      openclaw: {
        plugin: { id: "known-manifest-source-ref" },
        install: {
          sourceRef: "acme-npm",
          npmSpec: "@acme/known-manifest-source-ref",
        },
      },
    };
    const implicitNameInstall = {
      name: "@acme/implicit-name-install",
      kind: "plugin",
      openclaw: { plugin: { id: "implicit-name-install" } },
    };
    const topLevelCandidateOnly = {
      name: "@acme/top-level-candidate-only",
      kind: "plugin",
      install: {
        candidates: [{ sourceRef: "acme-npm", package: "@acme/top-level-candidate-only" }],
      },
      openclaw: {
        plugin: { id: "top-level-candidate-only" },
        install: { npmSpec: "@acme/top-level-candidate-only" },
      },
    };
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 11,
      entries: [
        missingManifestSourceRef,
        implicitNameInstall,
        topLevelCandidateOnly,
        knownManifestSourceRef,
      ],
    });

    const catalogConfig = {
      feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
      sources: { "acme-npm": { type: "npm" as const } },
    };

    expect(
      validateOfficialExternalPluginCatalogEntrySourceRefs(missingManifestSourceRef, {
        catalogConfig,
        requireManifestInstallSourceRef: true,
      }),
    ).toEqual(["feed install candidate is missing sourceRef"]);
    expect(
      validateOfficialExternalPluginCatalogEntrySourceRefs(implicitNameInstall, {
        catalogConfig,
        requireManifestInstallSourceRef: true,
      }),
    ).toEqual(["feed install candidate is missing sourceRef"]);
    expect(
      validateOfficialExternalPluginCatalogEntrySourceRefs(topLevelCandidateOnly, {
        catalogConfig,
        requireManifestInstallSourceRef: true,
      }),
    ).toEqual(["feed install candidate is missing sourceRef"]);
    expect(
      validateOfficialExternalPluginCatalogEntrySourceRefs(knownManifestSourceRef, {
        catalogConfig,
        requireManifestInstallSourceRef: true,
      }),
    ).toEqual([]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@acme/known-manifest-source-ref"]);
  });

  it("filters hosted feed entries that reference unknown local source profiles", async () => {
    const knownEntry = {
      name: "@openclaw/source-ref-known",
      kind: "plugin",
      install: {
        candidates: [{ sourceRef: "public-clawhub", package: "@openclaw/source-ref-known" }],
      },
      openclaw: { plugin: { id: "source-ref-known" } },
    };
    const unknownEntry = {
      name: "@openclaw/source-ref-unknown",
      kind: "plugin",
      install: {
        candidates: [{ sourceRef: "attacker-npm", package: "@openclaw/source-ref-unknown" }],
      },
      openclaw: { plugin: { id: "source-ref-unknown" } },
    };
    const missingEntry = {
      name: "@openclaw/source-ref-missing",
      kind: "plugin",
      install: { candidates: [{ package: "@openclaw/source-ref-missing" }] },
      openclaw: { plugin: { id: "source-ref-missing" } },
    };
    const manifestInstallWithoutSourceRef = {
      name: "@openclaw/source-ref-manifest-missing",
      kind: "plugin",
      install: {
        candidates: [
          { sourceRef: "public-clawhub", package: "@openclaw/source-ref-manifest-missing" },
        ],
      },
      openclaw: {
        plugin: { id: "source-ref-manifest-missing" },
        install: { npmSpec: "@openclaw/source-ref-manifest-missing" },
      },
    };
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 10,
      entries: [knownEntry, unknownEntry, missingEntry, manifestInstallWithoutSourceRef],
    });

    expect(validateOfficialExternalPluginCatalogEntrySourceRefs(knownEntry)).toEqual([]);
    expect(validateOfficialExternalPluginCatalogEntrySourceRefs(unknownEntry)).toEqual([
      'feed install candidate references unknown sourceRef "attacker-npm"',
    ]);
    expect(validateOfficialExternalPluginCatalogEntrySourceRefs(missingEntry)).toEqual([
      "feed install candidate is missing sourceRef",
    ]);
    expect(
      validateOfficialExternalPluginCatalogEntrySourceRefs(manifestInstallWithoutSourceRef),
    ).toEqual([]);
    expect(
      filterOfficialExternalPluginCatalogEntriesBySourceRefs([
        knownEntry,
        unknownEntry,
        missingEntry,
        manifestInstallWithoutSourceRef,
      ]).map((entry) => entry.name),
    ).toEqual(["@openclaw/source-ref-known", "@openclaw/source-ref-manifest-missing"]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@openclaw/source-ref-known",
      "@openclaw/source-ref-manifest-missing",
    ]);
  });

  it("falls back to the bundled catalog when hosted feed validation fails", async () => {
    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ schemaVersion: 1, id: " ", entries: [] }), {
            status: 200,
          }),
      ),
    });

    expect(result.source).toBe("bundled-fallback");
    expect(result.entries.length).toBe(listOfficialExternalPluginCatalogEntries().length);
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("supported schema version");
      expect(result.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("falls back to the bundled catalog on HTTP 304 until a snapshot cache exists", async () => {
    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      fetchImpl: vi.fn(
        async () =>
          new Response(null, {
            status: 304,
            headers: { etag: '"same"', "last-modified": "Mon, 22 Jun 2026 01:00:00 GMT" },
          }),
      ),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("HTTP 304");
      expect(result.metadata).toMatchObject({
        status: 304,
        etag: '"same"',
        lastModified: "Mon, 22 Jun 2026 01:00:00 GMT",
      });
    }
  });

  it("writes a validated hosted feed snapshot after a successful fetch", async () => {
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore();
    const writeSpy = vi.spyOn(snapshotStore, "write");
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 3,
      entries: [
        {
          name: "@openclaw/snapshot-write-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "snapshot-write-proof" } },
        },
      ],
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      now: () => new Date("2026-06-22T01:02:03.000Z"),
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { etag: '"fresh"' },
          }),
      ),
    });

    expect(result.source).toBe("hosted");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const snapshot = await snapshotStore.read(
      result.source === "hosted" ? result.metadata.url : "",
    );
    expect(snapshot).toMatchObject({
      body,
      savedAt: "2026-06-22T01:02:03.000Z",
      metadata: { etag: '"fresh"' },
    });
    expect(snapshot?.metadata.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails explicit refreshes when required snapshot persistence fails", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 4,
      entries: [
        {
          name: "@openclaw/snapshot-write-fail-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "snapshot-write-fail-proof" } },
        },
      ],
    });
    const snapshotStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw new Error("state database is read-only");
      }),
    };

    await expect(
      loadHostedOfficialExternalPluginCatalogEntries({
        snapshotStore,
        requireSnapshotWrite: true,
        fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      }),
    ).rejects.toThrow("state database is read-only");

    expect(snapshotStore.write).toHaveBeenCalledTimes(1);
  });

  it("reads the latest accepted snapshot in offline mode without fetching", async () => {
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore();
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 5,
      entries: [
        {
          name: "@openclaw/offline-snapshot-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "offline-snapshot-proof" } },
        },
      ],
    });
    const seedFetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { etag: '"offline"' },
        }),
    );
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      fetchImpl: seedFetch,
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }

    const offlineFetch = vi.fn(async () => new Response(null, { status: 500 }));
    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      fetchImpl: offlineFetch,
      offline: true,
    });

    expect(offlineFetch).not.toHaveBeenCalled();
    expect(result.source).toBe("hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/offline-snapshot-proof"]);
    if (result.source === "hosted-snapshot") {
      expect(result.error).toBe("hosted catalog feed offline mode");
      expect(result.metadata.checksum).toBe(seeded.metadata.checksum);
    }
  });

  it("re-verifies a signed snapshot before using it in offline mode", async () => {
    const signed = signedHostedCatalogFeed();
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      {
        body: signed.body,
        metadata: {
          url: "https://packages.acme.example/openclaw/feed",
          status: 200,
          checksum: `sha256:${crypto.createHash("sha256").update(signed.body).digest("hex")}`,
        },
        savedAt: "2026-06-22T04:05:06.000Z",
        trust: {
          mode: "signed",
          signedBy: "acme-root",
          signatureCount: 1,
          threshold: 1,
          verifiedAt: "2026-06-22T04:05:06.000Z",
        },
      },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig: {
        feeds: {
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: {
              mode: "signed",
              keys: [{ keyId: "acme-root", publicKey: signed.publicKeyPem }],
            },
          },
        },
        sources: { "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" } },
      },
      snapshotStore,
      offline: true,
      fetchImpl: vi.fn(),
    });

    expect(result.source).toBe("hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-refresh-proof"]);
    if (result.source === "hosted-snapshot") {
      expect(result.trust).toMatchObject({
        mode: "signed",
        signedBy: "acme-root",
        signatureCount: 1,
        threshold: 1,
      });
    }
  });

  it("does not use an old unsigned snapshot for a signed feed profile", async () => {
    const unsignedBody = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 9,
      entries: [
        {
          name: "@openclaw/unsigned-snapshot-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "unsigned-snapshot-proof" } },
        },
      ],
    });
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      {
        body: unsignedBody,
        metadata: {
          url: "https://packages.acme.example/openclaw/feed",
          status: 200,
          checksum: `sha256:${crypto.createHash("sha256").update(unsignedBody).digest("hex")}`,
        },
        savedAt: "2026-06-22T04:05:06.000Z",
      },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig: {
        feeds: {
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: {
              mode: "signed",
              keys: [
                {
                  keyId: "acme-root",
                  publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              ],
            },
          },
        },
      },
      snapshotStore,
      offline: true,
      fetchImpl: vi.fn(),
    });

    expect(result.source).toBe("bundled-fallback");
    expect(result.entries).toEqual([]);
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("snapshot fallback failed");
      expect(result.error).toContain("signed envelope is malformed");
    }
  });

  it("persists hosted feed snapshots in OpenClaw state for HTTP 304 reuse", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-hosted-catalog-"));
    try {
      const body = JSON.stringify({
        schemaVersion: 1,
        id: "openclaw-official-external-plugins",
        generatedAt: "2026-06-22T00:00:00.000Z",
        sequence: 7,
        entries: [
          {
            name: "@openclaw/sqlite-snapshot-proof",
            kind: "plugin",
            openclaw: { plugin: { id: "sqlite-snapshot-proof" } },
          },
        ],
      });

      const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
        stateDir,
        now: () => new Date("2026-06-22T02:03:04.000Z"),
        fetchImpl: vi.fn(
          async () =>
            new Response(body, {
              status: 200,
              headers: {
                etag: '"sqlite"',
                "last-modified": "Mon, 22 Jun 2026 02:00:00 GMT",
              },
            }),
        ),
      });
      if (seeded.source !== "hosted") {
        throw new Error("expected seeded hosted feed");
      }
      closeOpenClawStateDatabaseForTest();

      const result = await loadHostedOfficialExternalPluginCatalogEntries({
        stateDir,
        fetchImpl: vi.fn(async () => new Response(null, { status: 304 })),
      });

      expect(result.source).toBe("hosted-snapshot");
      expect(result.entries.map((entry) => entry.name)).toEqual([
        "@openclaw/sqlite-snapshot-proof",
      ]);
      if (result.source === "hosted-snapshot") {
        expect(result.snapshot.savedAt).toBe("2026-06-22T02:03:04.000Z");
        expect(result.metadata.checksum).toBe(seeded.metadata.checksum);
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      rmSync(stateDir, { recursive: true, force: true });
    }
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

  it("applies custom source-ref validation to exception snapshot fallback", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 12,
      entries: [
        {
          name: "@acme/snapshot-missing-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "snapshot-missing-source-ref" },
            install: { npmSpec: "@acme/snapshot-missing-source-ref" },
          },
        },
        {
          name: "@acme/snapshot-known-source-ref",
          kind: "plugin",
          openclaw: {
            plugin: { id: "snapshot-known-source-ref" },
            install: { sourceRef: "acme-npm", npmSpec: "@acme/snapshot-known-source-ref" },
          },
        },
      ],
    });
    const catalogConfig = {
      feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
      sources: { "acme-npm": { type: "npm" as const } },
    };
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig,
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      { body, metadata: seeded.metadata, savedAt: "2026-06-22T01:02:03.000Z" },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      feedProfile: "acme",
      catalogConfig,
      snapshotStore,
      fetchImpl: vi.fn(async () => new Response("{ nope", { status: 200 })),
    });

    expect(result.source).toBe("hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@acme/snapshot-known-source-ref"]);
  });

  it("uses the last known good snapshot when the hosted feed returns HTTP 304", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 4,
      entries: [
        {
          name: "@openclaw/snapshot-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "snapshot-proof" } },
        },
      ],
    });
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { etag: '"snapshot-v1"' },
          }),
      ),
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      {
        body,
        metadata: seeded.metadata,
        savedAt: "2026-06-22T01:02:03.000Z",
      },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      ifNoneMatch: '"snapshot-v1"',
      fetchImpl: vi.fn(
        async () =>
          new Response(null, {
            status: 304,
            headers: { etag: '"snapshot-v1"' },
          }),
      ),
    });

    expect(result.source).toBe("hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/snapshot-proof"]);
    if (result.source === "hosted-snapshot") {
      expect(result.error).toContain("HTTP 304");
      expect(result.snapshot.savedAt).toBe("2026-06-22T01:02:03.000Z");
      expect(result.metadata.checksum).toBe(seeded.metadata.checksum);
    }
  });

  it("does not use a stale snapshot when HTTP 304 validators do not match", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 4,
      entries: [
        {
          name: "@openclaw/stale-snapshot-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "stale-snapshot-proof" } },
        },
      ],
    });
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { etag: '"snapshot-v1"' },
          }),
      ),
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      {
        body,
        metadata: seeded.metadata,
        savedAt: "2026-06-22T01:02:03.000Z",
      },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      ifNoneMatch: '"snapshot-v2"',
      fetchImpl: vi.fn(
        async () =>
          new Response(null, {
            status: 304,
            headers: { etag: '"snapshot-v2"' },
          }),
      ),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("snapshot fallback failed");
      expect(result.error).toContain("ETag");
    }
  });

  it("uses a valid snapshot before bundled fallback when hosted validation fails", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 5,
      entries: [
        {
          name: "@openclaw/snapshot-validation-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "snapshot-validation-proof" } },
        },
      ],
    });
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      { body, metadata: seeded.metadata, savedAt: "2026-06-22T01:02:03.000Z" },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      fetchImpl: vi.fn(async () => new Response("{ nope", { status: 200 })),
    });

    expect(result.source).toBe("hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@openclaw/snapshot-validation-proof",
    ]);
    if (result.source === "hosted-snapshot") {
      expect(result.error).toContain("JSON");
    }
  });

  it("does not use a stale snapshot when hosted validation fails with unmatched validators", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 5,
      entries: [
        {
          name: "@openclaw/stale-validation-snapshot-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "stale-validation-snapshot-proof" } },
        },
      ],
    });
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
      fetchImpl: vi.fn(
        async () => new Response(body, { status: 200, headers: { etag: '"snapshot-v1"' } }),
      ),
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      { body, metadata: seeded.metadata, savedAt: "2026-06-22T01:02:03.000Z" },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      ifNoneMatch: '"snapshot-v2"',
      fetchImpl: vi.fn(async () => new Response("{ nope", { status: 200 })),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("snapshot fallback failed");
      expect(result.error).toContain("ETag");
    }
  });

  it("falls back to bundled entries when the snapshot is invalid", async () => {
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      {
        body: JSON.stringify({
          schemaVersion: 1,
          id: "openclaw-official-external-plugins",
          generatedAt: "2026-06-22T00:00:00.000Z",
          sequence: 1,
          entries: [],
        }),
        metadata: {
          url: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL,
          status: 200,
          checksum: "sha256:not-current",
        },
        savedAt: "2026-06-22T01:02:03.000Z",
      },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      fetchImpl: vi.fn(async () => new Response(null, { status: 304 })),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("snapshot fallback failed");
      expect(result.error).toContain("checksum mismatch");
    }
  });

  it("does not use a snapshot that violates the expected checksum", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 6,
      entries: [
        {
          name: "@openclaw/snapshot-pin-proof",
          kind: "plugin",
          openclaw: { plugin: { id: "snapshot-pin-proof" } },
        },
      ],
    });
    const seeded = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(),
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
    });
    if (seeded.source !== "hosted") {
      throw new Error("expected seeded hosted feed");
    }
    const snapshotStore = createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore([
      { body, metadata: seeded.metadata, savedAt: "2026-06-22T01:02:03.000Z" },
    ]);

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore,
      expectedSha256: "sha256:not-current",
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("snapshot fallback failed");
      expect(result.error).toContain("expected checksum");
    }
  });

  it("falls back to the bundled catalog on checksum mismatch and oversized bodies", async () => {
    const mismatch = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      expectedSha256: "sha256:not-current",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              id: "openclaw-official-external-plugins",
              generatedAt: "2026-06-22T00:00:00.000Z",
              sequence: 1,
              entries: [],
            }),
            { status: 200 },
          ),
      ),
    });
    expect(mismatch.source).toBe("bundled-fallback");
    if (mismatch.source === "bundled-fallback") {
      expect(mismatch.error).toContain("checksum mismatch");
      expect(mismatch.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    const oversized = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      maxBytes: 4,
      fetchImpl: vi.fn(async () => new Response("12345", { status: 200 })),
    });
    expect(oversized.source).toBe("bundled-fallback");
    if (oversized.source === "bundled-fallback") {
      expect(oversized.error).toContain("exceeds 4 bytes");
    }
  });

  it("rejects non-streaming hosted feeds before buffering underreported bodies", async () => {
    const oversized = "x".repeat(8192);
    const response = new Response(oversized, {
      status: 200,
      headers: { "content-length": "1" },
    });
    Object.defineProperty(response, "body", { value: null });
    const arrayBuffer = vi.fn(response.arrayBuffer.bind(response));
    Object.defineProperty(response, "arrayBuffer", { value: arrayBuffer });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      maxBytes: 4096,
      fetchImpl: vi.fn(async () => response),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("streaming response body unavailable");
    }
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects non-streaming hosted feeds without content-length", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:00.000Z",
      sequence: 1,
      entries: [],
    });
    const response = new Response(body, { status: 200 });
    Object.defineProperty(response, "body", { value: null });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      fetchImpl: vi.fn(async () => response),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("streaming response body unavailable");
    }
  });

  it("rejects oversized streaming hosted feeds incrementally", async () => {
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 3) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });

    const result = await loadHostedOfficialExternalPluginCatalogEntries({
      snapshotStore: null,
      maxBytes: 1024 * 1024,
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    expect(result.source).toBe("bundled-fallback");
    if (result.source === "bundled-fallback") {
      expect(result.error).toContain("exceeds 1048576 bytes");
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
