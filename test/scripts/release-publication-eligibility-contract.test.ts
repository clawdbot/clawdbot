import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReleasePlanLock } from "../../scripts/release-plan-contract.mjs";
import type { VerifiedReleasePlanLock } from "../../scripts/release-plan-producer.mts";
import {
  canonicalReleasePublicationEligibilityReceiptJson,
  createReleasePublicationEligibilityReceipt,
  parseReleasePublicationEligibilityReceiptJson,
  RELEASE_PUBLICATION_ELIGIBILITY_CANONICALIZATION,
  RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS,
  RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH,
  verifyReleasePublicationEligibilityReceipt,
} from "../../scripts/release-publication-eligibility-contract.mjs";

const releasePlanLock = JSON.parse(
  readFileSync(resolve("test/fixtures/release-plan-lock-v1.compatibility.json"), "utf8"),
) as VerifiedReleasePlanLock;
const provenance = {
  repository: releasePlanLock.plan.tooling.repository,
  workflow_path: RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH,
  workflow_ref: releasePlanLock.plan.tooling.ref,
  workflow_sha: releasePlanLock.plan.tooling.sha,
  run_id: "123456",
  run_attempt: 2,
  job: "publication-eligibility",
  artifact_id: "654321",
  artifact_digest: `sha256:${"d".repeat(64)}`,
} as const;

function createReceipt() {
  return createReleasePublicationEligibilityReceipt({
    schema: "openclaw.release-publication-eligibility.v1",
    evidence_scope: "validation-start-only",
    publication_authorized: false,
    release_plan_digest: releasePlanLock.digest,
    started_at: "2026-08-21T00:00:00.000Z",
    completed_at: "2026-08-21T00:00:02.000Z",
    expires_at: "2026-08-21T00:05:00.000Z",
    registries: {
      clawhub: "https://clawhub.ai",
      npm: "https://registry.npmjs.org",
    },
    provenance,
    observations: {
      latest_dependencies: [
        {
          name: "@openai/codex",
          required_version: "0.149.0",
          observed_version: "0.149.0",
        },
      ],
      npm: [
        { name: "@openclaw/example", version: "2026.8.1-beta.2", published: false },
        { name: "openclaw", version: "2026.8.1-beta.2", published: true },
      ],
      clawhub: [
        {
          name: "@openclaw/example",
          version: "2026.8.1-beta.2",
          package_exists: true,
          trusted_publisher: true,
          published: false,
        },
      ],
    },
    plans: {
      npm: [
        { name: "@openclaw/example", version: "2026.8.1-beta.2", status: "vacant" },
        { name: "openclaw", version: "2026.8.1-beta.2", status: "already-published" },
      ],
      clawhub: [{ name: "@openclaw/example", version: "2026.8.1-beta.2", status: "vacant" }],
    },
  });
}

describe("release publication eligibility receipt contract", () => {
  it("round-trips only canonical ASCII bytes", () => {
    const receipt = createReceipt();
    const text = canonicalReleasePublicationEligibilityReceiptJson(receipt);

    expect(RELEASE_PUBLICATION_ELIGIBILITY_CANONICALIZATION).toBe(
      "ascii-sorted-compact-json-trailing-newline-v1",
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);
    expect(parseReleasePublicationEligibilityReceiptJson(text)).toEqual(receipt);
    expect(
      verifyReleasePublicationEligibilityReceipt(
        receipt,
        releasePlanLock,
        provenance,
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toEqual(receipt);
  });

  it("rejects duplicate, reordered, pretty, and non-ASCII bytes", () => {
    const text = canonicalReleasePublicationEligibilityReceiptJson(createReceipt());
    const receipt = JSON.parse(text) as Record<string, unknown>;
    const duplicate = text.replace(
      '{"completed_at":',
      `{"completed_at":"2026-08-21T00:00:02.000Z","completed_at":`,
    );

    expect(() => parseReleasePublicationEligibilityReceiptJson(duplicate)).toThrow("duplicate key");
    const { digest, ...body } = receipt;
    expect(() =>
      parseReleasePublicationEligibilityReceiptJson(`${JSON.stringify({ digest, ...body })}\n`),
    ).toThrow("canonical bytes");
    expect(() =>
      parseReleasePublicationEligibilityReceiptJson(`${JSON.stringify(receipt, null, 2)}\n`),
    ).toThrow("compact printable ASCII");
    expect(() =>
      parseReleasePublicationEligibilityReceiptJson(text.replace("@openclaw", "@öpenclaw")),
    ).toThrow("printable ASCII");
  });

  it("binds the canonical body, ReleasePlan digest, inventory, and freshness", () => {
    const receipt = createReceipt();
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        {
          ...receipt,
          completed_at: "2026-08-21T00:00:02.001Z",
        },
        releasePlanLock,
        provenance,
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toThrow("digest does not match");
    const otherLock = createReleasePlanLock({
      ...releasePlanLock.plan,
      candidate_sha: "c".repeat(40),
    }) as VerifiedReleasePlanLock;
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        receipt,
        otherLock,
        provenance,
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toThrow("different ReleasePlan digest");
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        receipt,
        releasePlanLock,
        provenance,
        Date.parse("2026-08-21T00:05:00.001Z"),
      ),
    ).toThrow("expired");
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        receipt,
        releasePlanLock,
        provenance,
        Date.parse("2026-08-21T00:00:01.999Z"),
      ),
    ).toThrow("not yet valid");
  });

  it("binds exact GitHub provenance and never grants publication authority", () => {
    const receipt = createReceipt();
    expect(receipt).toMatchObject({
      evidence_scope: "validation-start-only",
      publication_authorized: false,
      provenance,
    });
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        receipt,
        releasePlanLock,
        { ...provenance, run_id: "123457" },
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toThrow("expected GitHub run");
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        receipt,
        releasePlanLock,
        { ...provenance, workflow_sha: "c".repeat(40) },
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toThrow("expected GitHub run");
    const { digest: _digest, ...body } = receipt;
    const wrongToolingReceipt = createReleasePublicationEligibilityReceipt({
      ...body,
      provenance: { ...provenance, workflow_sha: "c".repeat(40) },
    });
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        wrongToolingReceipt,
        releasePlanLock,
        wrongToolingReceipt.provenance,
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toThrow("producer and ReleasePlan tooling");
    const wrongProducerReceipt = createReleasePublicationEligibilityReceipt({
      ...body,
      provenance: {
        ...provenance,
        workflow_path: releasePlanLock.plan.tooling.workflow_path,
      },
    });
    expect(() =>
      verifyReleasePublicationEligibilityReceipt(
        wrongProducerReceipt,
        releasePlanLock,
        wrongProducerReceipt.provenance,
        Date.parse("2026-08-21T00:00:03.000Z"),
      ),
    ).toThrow("producer and ReleasePlan tooling");
    expect(() =>
      createReleasePublicationEligibilityReceipt({
        ...body,
        publication_authorized: true,
      }),
    ).toThrow("never authorize publication");
    for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() =>
        verifyReleasePublicationEligibilityReceipt(
          receipt,
          releasePlanLock,
          provenance,
          invalidNow,
        ),
      ).toThrow("finite integer");
    }
  });

  it("requires a five-minute receipt and rejects ineligible ClawHub state", () => {
    const receipt = createReceipt();
    const { digest: _digest, ...body } = receipt;
    expect(() =>
      createReleasePublicationEligibilityReceipt({
        ...body,
        expires_at: new Date(
          Date.parse(receipt.started_at) + RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS + 1,
        ).toISOString(),
      }),
    ).toThrow("exactly five minutes");
    expect(() =>
      createReleasePublicationEligibilityReceipt({
        ...body,
        observations: {
          ...receipt.observations,
          clawhub: receipt.observations.clawhub.map((entry) =>
            Object.assign({}, entry, { trusted_publisher: false }),
          ),
        },
      }),
    ).toThrow("trusted publisher is missing");
  });
});
