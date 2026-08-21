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
  validateReleasePlanLock,
} from "../../scripts/release-plan-contract.mjs";

const fixtureDir = resolve("test/fixtures");
const sourceFixture = JSON.parse(
  readFileSync(resolve(fixtureDir, "release-plan-v1.source.json"), "utf8"),
) as Record<string, unknown>;
const lockFixture = JSON.parse(
  readFileSync(resolve(fixtureDir, "release-plan-lock-v1.compatibility.json"), "utf8"),
) as Record<string, unknown>;

describe("release plan contract", () => {
  it("matches the exact public and private-consumer compatibility fixture", () => {
    const canonical = canonicalReleasePlanJson(sourceFixture);

    expect(RELEASE_PLAN_CANONICALIZATION).toBe("ascii-sorted-compact-json-trailing-newline-v1");
    expect(createReleasePlanLock(sourceFixture)).toEqual(lockFixture);
    expect(validateReleasePlanLock(lockFixture).plan).toEqual(sourceFixture);
    expect(Buffer.byteLength(canonical, "ascii")).toBe(943);
    expect(releasePlanDigest(sourceFixture)).toBe(
      "sha256:f48b6de82045491d086c8fafb8217ea565a99a87a01e96bd01a30c9690f89462",
    );
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical.slice(0, -1)).not.toMatch(/[\r\n]/u);
    expect(canonical.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);
  });

  it("round-trips the exact outer lock envelope", () => {
    const canonicalLock = canonicalReleasePlanLockJson(lockFixture);
    expect(parseReleasePlanLockJson(canonicalLock)).toEqual(lockFixture);
    expect(Object.keys(lockFixture).toSorted()).toEqual(["digest", "plan", "schema"]);
  });

  it("rejects duplicate keys, unknown authority, and non-ASCII data", () => {
    const canonicalLock = canonicalReleasePlanLockJson(lockFixture);
    expect(() =>
      parseReleasePlanLockJson(
        canonicalLock.replace('{"digest":', `{"digest":"${String(lockFixture.digest)}","digest":`),
      ),
    ).toThrow("duplicate key");
    expect(() => validateReleasePlan({ ...sourceFixture, run_id: "123" })).toThrow(
      "release plan keys must be exactly",
    );
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        release_id: "2026.8.1-béta.2",
      }),
    ).toThrow("printable ASCII");
  });

  it("keeps ValidationAttempt state outside ReleasePlan", () => {
    const plan = validateReleasePlan(sourceFixture);
    expect(plan).not.toHaveProperty("attempt");
    expect(plan).not.toHaveProperty("run_id");
    expect(plan).not.toHaveProperty("timestamp");
    expect(plan).not.toHaveProperty("rerun_group");
    expect(plan).not.toHaveProperty("filters");
    expect(plan).not.toHaveProperty("local_path");
  });

  it("rejects unsorted inventory and purpose-policy drift", () => {
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        inventory: {
          ...(sourceFixture.inventory as Record<string, unknown>),
          packages: [
            {
              name: "openclaw",
              version: "2026.8.1-beta.2",
              targets: ["npm"],
            },
            {
              name: "@openclaw/example",
              version: "2026.8.1-beta.2",
              targets: ["clawhub", "npm"],
            },
          ],
        },
      }),
    ).toThrow("packages must have unique names in ascending ASCII order");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        validation: {
          allowed_groups: ["all"],
          profile: "full",
          soak: true,
        },
      }),
    ).toThrow("beta-publish validation policy is invalid");
  });
});
