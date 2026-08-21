import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  RELEASE_PLAN_CANONICALIZATION,
  releasePlanDigest,
  validateReleasePlan,
  validateValidationAttemptReceipt,
  validateValidationAttemptRequest,
} from "../../scripts/release-plan-contract.mjs";

const fixtureDir = resolve("test/fixtures");
const sourceText = readFileSync(resolve(fixtureDir, "release-plan-v1.source.json"), "utf8");
const lockText = readFileSync(
  resolve(fixtureDir, "release-plan-lock-v1.compatibility.json"),
  "utf8",
);
const sourceFixture = JSON.parse(sourceText) as Record<string, unknown>;
const lockFixture = JSON.parse(lockText) as Record<string, unknown>;

describe("release plan contract", () => {
  it("pins exact canonical source and lock bytes as the cross-repo golden fixture", () => {
    expect(RELEASE_PLAN_CANONICALIZATION).toBe("ascii-sorted-compact-json-trailing-newline-v1");
    expect(sourceText).toBe(canonicalReleasePlanJson(sourceFixture));
    expect(lockText).toBe(canonicalReleasePlanLockJson(lockFixture));
    expect(createReleasePlanLock(sourceFixture)).toEqual(lockFixture);
    expect(parseReleasePlanLockJson(lockText)).toEqual(lockFixture);
    expect(lockText.endsWith("\n")).toBe(true);
    expect(lockText.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);
  });

  it("rejects duplicate, reordered, pretty, CRLF, and non-ASCII lock bytes", () => {
    const duplicate = lockText.replace(
      '{"digest":',
      `{"digest":"${String(lockFixture.digest)}","digest":`,
    );
    expect(() => parseReleasePlanLockJson(duplicate)).toThrow("duplicate key");
    expect(() =>
      parseReleasePlanLockJson(
        `${JSON.stringify({
          schema: lockFixture.schema,
          plan: lockFixture.plan,
          digest: lockFixture.digest,
        })}\n`,
      ),
    ).toThrow("canonical bytes");
    expect(() => parseReleasePlanLockJson(`${JSON.stringify(lockFixture, null, 2)}\n`)).toThrow(
      "compact printable ASCII",
    );
    expect(() => parseReleasePlanLockJson(lockText.replace(/\n$/u, "\r\n"))).toThrow(
      "exactly one trailing LF",
    );
    expect(() =>
      parseReleasePlanLockJson(lockText.replace("openclaw/openclaw", "opénclaw")),
    ).toThrow("printable ASCII");
  });

  it("enforces the purpose, version, tag, and target context matrix", () => {
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        purpose: "stable-publish",
        validation: {
          allowed_groups: ["all", "ci", "package"],
          exceptions: [],
          profile: "stable",
          soak: true,
        },
      }),
    ).toThrow("stable-publish release plan version must be stable");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        purpose: "main-qualification",
        tag: null,
        target_context_ref: "refs/tags/null",
        validation: {
          allowed_groups: ["all", "ci", "package"],
          exceptions: [],
          profile: "full",
          soak: true,
        },
      }),
    ).toThrow("candidate SHA context");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        tag: "v2026.8.1-beta.3",
      }),
    ).toThrow("exact version tag context");
  });

  it("rejects unknown authority, invalid ordering, and unsupported versions", () => {
    expect(() => validateReleasePlan({ ...sourceFixture, run_id: "123" })).toThrow(
      "release plan keys must be exactly",
    );
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        version: "2026.08.1-beta.2",
        release_id: "2026.08.1-beta.2",
        tag: "v2026.08.1-beta.2",
        target_context_ref: "refs/tags/v2026.08.1-beta.2",
      }),
    ).toThrow("supported release version");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        inventory: {
          ...(sourceFixture.inventory as Record<string, unknown>),
          packages: [
            { name: "openclaw", targets: ["npm"], version: "2026.8.1-beta.2" },
            {
              name: "@openclaw/example",
              targets: ["clawhub", "npm"],
              version: "2026.8.1-beta.2",
            },
          ],
        },
      }),
    ).toThrow("ascending ASCII order");
  });

  it("keeps ValidationAttempt request and receipt state outside ReleasePlan", () => {
    const plan = validateReleasePlan(sourceFixture);
    const planDigest = releasePlanDigest(plan);
    expect(plan).not.toHaveProperty("run_id");
    expect(plan).not.toHaveProperty("rerun_group");
    expect(
      validateValidationAttemptRequest({
        schema: "openclaw.validation-attempt-request.v1",
        plan_digest: planDigest,
        rerun_group: "package",
        filters: { platform: "linux", package: "openclaw" },
        fail_fast: false,
        reuse_evidence: true,
      }),
    ).toMatchObject({ plan_digest: planDigest, rerun_group: "package" });
    expect(
      validateValidationAttemptReceipt({
        schema: "openclaw.validation-attempt-receipt.v1",
        plan_digest: planDigest,
        request_digest: `sha256:${"b".repeat(64)}`,
        run_id: "123",
        run_attempt: "2",
        workflow_ref: "release-ci/example",
        workflow_full_ref: "refs/heads/release-ci/example",
        workflow_sha: "c".repeat(40),
        target_sha: "a".repeat(40),
      }),
    ).toMatchObject({ run_attempt: "2", run_id: "123" });
  });
});
