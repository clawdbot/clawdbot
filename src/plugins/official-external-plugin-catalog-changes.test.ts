import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyVerifiedOfficialExternalPluginCatalogChangeBodies,
  applyVerifiedOfficialExternalPluginCatalogChanges,
  parseOfficialExternalPluginCatalogIncrementalSnapshot,
  serializeOfficialExternalPluginCatalogIncrementalSnapshot,
  verifyOfficialExternalPluginCatalogChangeEnvelopeBody,
} from "./official-external-plugin-catalog-changes.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

const CHANGES_PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-changes.v1";

const keys = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function signChangePayload(payload: unknown): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const typeBytes = Buffer.from(CHANGES_PAYLOAD_TYPE, "utf8");
  const signingInput = Buffer.concat([
    Buffer.from(
      `DSSEv1 ${typeBytes.length} ${CHANGES_PAYLOAD_TYPE} ${payloadBytes.length} `,
      "utf8",
    ),
    payloadBytes,
  ]);
  return JSON.stringify({
    payloadType: CHANGES_PAYLOAD_TYPE,
    payload: payloadBytes.toString("base64url"),
    signatures: [
      {
        keyid: "catalog-root",
        sig: crypto.sign(null, signingInput, keys.privateKey).toString("base64url"),
      },
    ],
  });
}

function catalogEntry(id: string) {
  return {
    type: "plugin" as const,
    id,
    title: id,
    version: "1.0.0",
    state: "available",
    publisher: { id: "openclaw", trust: "official" },
    install: {
      candidates: [
        {
          sourceRef: "public-clawhub",
          package: id,
          version: "1.0.0",
          integrity: `sha256:${"a".repeat(64)}`,
        },
      ],
    },
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    feedId: "clawhub-official",
    fromSequence: 1,
    toSequence: 3,
    generatedAt: "2026-07-24T12:00:00.000Z",
    expiresAt: "2026-07-24T12:05:00.000Z",
    requestCursor: null,
    pageIndex: 0,
    startIndex: 0,
    changeCount: 3,
    changes: [
      { sequence: 2, operation: "upsert", entry: catalogEntry("beta") },
      {
        sequence: 2,
        operation: "metadata",
        metadata: { description: "Current catalog" },
      },
    ],
    nextCursor: "page-2",
    ...overrides,
  };
}

const baseFeed: OfficialExternalPluginCatalogFeed = {
  schemaVersion: 1,
  id: "clawhub-official",
  sequence: 1,
  generatedAt: "2026-07-24T11:00:00.000Z",
  expiresAt: "2026-07-24T11:05:00.000Z",
  description: "Old catalog",
  entries: [catalogEntry("alpha")],
};

describe("official external plugin catalog changes", () => {
  it("verifies a complete paginated range and applies it atomically", () => {
    const bodies = [
      signChangePayload(page()),
      signChangePayload(
        page({
          requestCursor: "page-2",
          pageIndex: 1,
          startIndex: 2,
          changes: [{ sequence: 3, operation: "remove", entryId: "alpha", entryType: "plugin" }],
          nextCursor: null,
        }),
      ),
    ];

    const result = applyVerifiedOfficialExternalPluginCatalogChangeBodies({
      feed: baseFeed,
      changeBodies: bodies,
      trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }],
      expectedFeedId: "clawhub-official",
    });

    expect(result.feed).toMatchObject({
      sequence: 3,
      generatedAt: "2026-07-24T12:00:00.000Z",
      expiresAt: "2026-07-24T12:05:00.000Z",
      description: "Current catalog",
      entries: [{ id: "beta" }],
    });
  });

  it("rejects partial ranges, sequence gaps, and tampered envelopes", () => {
    const firstBody = signChangePayload(page());
    expect(() =>
      applyVerifiedOfficialExternalPluginCatalogChangeBodies({
        feed: baseFeed,
        changeBodies: [firstBody],
        trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }],
      }),
    ).toThrow("incomplete range");

    const gap = signChangePayload(
      page({
        toSequence: 4,
        changeCount: 1,
        changes: [{ sequence: 4, operation: "upsert", entry: catalogEntry("gap") }],
        nextCursor: null,
      }),
    );
    expect(() =>
      applyVerifiedOfficialExternalPluginCatalogChangeBodies({
        feed: baseFeed,
        changeBodies: [gap],
        trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }],
      }),
    ).toThrow("invalid sequence range");

    const envelope = JSON.parse(firstBody) as { payload: string };
    envelope.payload = `${envelope.payload.slice(0, -1)}A`;
    expect(() =>
      verifyOfficialExternalPluginCatalogChangeEnvelopeBody(JSON.stringify(envelope), {
        trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }],
      }),
    ).toThrow();
  });

  it("strictly parses signed reset responses without treating them as deltas", () => {
    const reset = {
      schemaVersion: 1,
      feedId: "clawhub-official",
      fromSequence: 1,
      currentSequence: 9,
      generatedAt: "2026-07-24T12:00:00.000Z",
      expiresAt: "2026-07-24T12:05:00.000Z",
      resetRequired: true,
      snapshotUrl: "https://clawhub.ai/api/v1/feeds/plugins",
    };
    const verified = verifyOfficialExternalPluginCatalogChangeEnvelopeBody(
      signChangePayload(reset),
      { trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }] },
    );
    expect(verified.payload).toMatchObject({
      resetRequired: true,
      currentSequence: 9,
    });
    expect(() =>
      verifyOfficialExternalPluginCatalogChangeEnvelopeBody(
        signChangePayload({ ...reset, unexpected: true }),
        { trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }] },
      ),
    ).toThrow("reset response is malformed");
  });

  it("round-trips the signed base and exact change envelope bytes", () => {
    const body = signChangePayload(
      page({ toSequence: 2, changeCount: 1, changes: [page().changes[0]], nextCursor: null }),
    );
    const serialized = serializeOfficialExternalPluginCatalogIncrementalSnapshot({
      baseBody: "signed-base",
      changeBodies: [body],
    });

    expect(parseOfficialExternalPluginCatalogIncrementalSnapshot(JSON.parse(serialized))).toEqual({
      kind: "official-external-plugin-catalog-changes-v1",
      baseBody: "signed-base",
      changeBodies: [body],
    });
  });

  it("accepts producer-shaped upserts with presentation and GitHub source metadata", () => {
    const entry = {
      ...catalogEntry("producer-plugin"),
      description: "Producer description",
      icon: "https://clawhub.ai/icons/producer-plugin.png",
      install: {
        candidates: [
          {
            sourceRef: "public-clawhub",
            package: "producer-plugin",
            version: "1.0.0",
            integrity: `sha256:${"a".repeat(64)}`,
            github: {
              repo: "openclaw/plugins",
              path: "plugins/producer-plugin",
              commit: "f".repeat(40),
              contentHash: `sha256:${"b".repeat(64)}`,
            },
          },
        ],
      },
    };
    const verified = verifyOfficialExternalPluginCatalogChangeEnvelopeBody(
      signChangePayload(
        page({
          toSequence: 2,
          changeCount: 1,
          changes: [{ sequence: 2, operation: "upsert", entry }],
          nextCursor: null,
        }),
      ),
      { trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }] },
    );

    expect(verified.payload).toMatchObject({ changes: [{ entry }] });
  });

  it("applies pages that the live path has already verified", () => {
    const body = signChangePayload(
      page({ toSequence: 2, changeCount: 1, changes: [page().changes[0]], nextCursor: null }),
    );
    const verified = verifyOfficialExternalPluginCatalogChangeEnvelopeBody(body, {
      trustedKeys: [{ keyId: "catalog-root", publicKey: keys.publicKey }],
    });

    expect(
      applyVerifiedOfficialExternalPluginCatalogChanges({
        feed: baseFeed,
        changes: [verified],
        expectedFeedId: "clawhub-official",
      }).feed,
    ).toMatchObject({ sequence: 2, entries: [{ id: "alpha" }, { id: "beta" }] });
  });

  it("bounds persisted change history so the caller can compact through the full root", () => {
    expect(() =>
      serializeOfficialExternalPluginCatalogIncrementalSnapshot({
        baseBody: "signed-base",
        changeBodies: Array.from({ length: 2048 }, () => "signed-change"),
      }),
    ).not.toThrow();
    expect(() =>
      serializeOfficialExternalPluginCatalogIncrementalSnapshot({
        baseBody: "signed-base",
        changeBodies: Array.from({ length: 2049 }, () => "signed-change"),
      }),
    ).toThrow("invalid change page count");
  });
});
