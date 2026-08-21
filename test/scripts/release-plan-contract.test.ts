import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  RELEASE_PLAN_CANONICALIZATION,
  validateReleasePlan,
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
    const nestedDuplicate = lockText.replace(
      '"tooling":{"ref":',
      '"tooling":{"ref":"ignored","\\u0072ef":',
    );
    expect(() => parseReleasePlanLockJson(nestedDuplicate)).toThrow("duplicate key");
    const arrayEntryDuplicate = lockText.replace(
      '{"name":"@openclaw/example","targets":',
      '{"name":"ignored","name":"@openclaw/example","targets":',
    );
    expect(() => parseReleasePlanLockJson(arrayEntryDuplicate)).toThrow("duplicate key");
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

  it("rejects values that JSON.stringify would erase or coerce", () => {
    const withUndefined = { ...sourceFixture, ignored: undefined };
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(sourceFixture));
    expect(() => canonicalReleasePlanJson(withUndefined)).toThrow("unsupported undefined");

    const withNan = { ...sourceFixture, tag: Number.NaN };
    expect(JSON.stringify(withNan)).toBe(JSON.stringify({ ...sourceFixture, tag: null }));
    expect(() => canonicalReleasePlanJson(withNan)).toThrow("must be finite");

    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      () => undefined,
      Symbol("ignored"),
      1n,
    ]) {
      expect(() => canonicalReleasePlanJson({ ...sourceFixture, ignored: value })).toThrow(
        "canonical JSON",
      );
    }
    expect(() => canonicalReleasePlanJson({ ...sourceFixture, ignored: -0 })).toThrow(
      "negative zero",
    );
  });

  it("rejects non-tree and non-data JSON structures", () => {
    const sparseGroups = ["all", , "package"];
    expect(JSON.stringify(sparseGroups)).toBe('["all",null,"package"]');
    expect(() =>
      canonicalReleasePlanJson({
        ...sourceFixture,
        validation: {
          ...(sourceFixture.validation as Record<string, unknown>),
          allowed_groups: sparseGroups,
        },
      }),
    ).toThrow("must be dense");

    const augmentedGroups = ["all", "ci", "package"];
    Object.defineProperty(augmentedGroups, "metadata", { enumerable: true, value: "ignored" });
    expect(() =>
      canonicalReleasePlanJson({
        ...sourceFixture,
        validation: {
          ...(sourceFixture.validation as Record<string, unknown>),
          allowed_groups: augmentedGroups,
        },
      }),
    ).toThrow("no extra properties");

    const cyclic = { ...sourceFixture } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => canonicalReleasePlanJson(cyclic)).toThrow("must not contain cycles");

    const nonPlain = Object.assign(new (class ReleasePlan {})(), sourceFixture);
    expect(() => canonicalReleasePlanJson(nonPlain)).toThrow("must be plain");

    const accessor = { ...sourceFixture };
    Object.defineProperty(accessor, "hidden", {
      enumerable: true,
      get: () => "ignored",
    });
    expect(() => canonicalReleasePlanJson(accessor)).toThrow("enumerable data properties");

    const symbolKey = { ...sourceFixture, [Symbol("ignored")]: true };
    expect(() => canonicalReleasePlanJson(symbolKey)).toThrow("must use string keys");
  });

  it("enforces the purpose, version, tag, and target context matrix", () => {
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        purpose: "stable-publish",
        validation: {
          allowed_groups: ["all", "ci", "package"],
          intent: "release-stable",
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
          intent: "main-weekly",
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

  it("binds purpose, intent, profile, and soak to one authoritative policy", () => {
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        validation: {
          ...(sourceFixture.validation as Record<string, unknown>),
          intent: "release-stable",
        },
      }),
    ).toThrow("beta-publish does not allow validation intent");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        validation: {
          ...(sourceFixture.validation as Record<string, unknown>),
          profile: "full",
        },
      }),
    ).toThrow("profile assertion conflicts");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        validation: {
          ...(sourceFixture.validation as Record<string, unknown>),
          soak: true,
        },
      }),
    ).toThrow("soak assertion conflicts");
  });

  it("accepts daily and weekly main qualification intents", () => {
    const mainPlan = {
      ...sourceFixture,
      purpose: "main-qualification",
      tag: null,
      target_context_ref: sourceFixture.candidate_sha,
    };
    expect(
      validateReleasePlan({
        ...mainPlan,
        validation: {
          allowed_groups: ["all", "ci", "package"],
          intent: "main-daily",
          profile: "beta",
          soak: false,
        },
      }).validation.intent,
    ).toBe("main-daily");
    expect(
      validateReleasePlan({
        ...mainPlan,
        validation: {
          allowed_groups: ["all", "ci", "package"],
          intent: "main-weekly",
          profile: "full",
          soak: true,
        },
      }).validation.intent,
    ).toBe("main-weekly");
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

  it("rejects arbitrary tooling routes", () => {
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        tooling: {
          ...(sourceFixture.tooling as Record<string, unknown>),
          ref: "refs/heads/main",
        },
      }),
    ).toThrow("protected release-publish tag");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        tooling: {
          ...(sourceFixture.tooling as Record<string, unknown>),
          ref: "refs/tags/release-publish/cccccccccccc-123",
        },
      }),
    ).toThrow("bound to its SHA");
    expect(() =>
      validateReleasePlan({
        ...sourceFixture,
        purpose: "main-qualification",
        tag: null,
        target_context_ref: sourceFixture.candidate_sha,
        tooling: {
          ...(sourceFixture.tooling as Record<string, unknown>),
          ref: "refs/heads/feature",
        },
        validation: {
          allowed_groups: ["all", "ci", "package"],
          intent: "main-weekly",
          profile: "full",
          soak: true,
        },
      }),
    ).toThrow("trusted main");
  });

  it("keeps run and rerun state outside ReleasePlan", () => {
    const plan = validateReleasePlan(sourceFixture);
    expect(plan).not.toHaveProperty("run_id");
    expect(plan).not.toHaveProperty("rerun_group");
    expect(plan).not.toHaveProperty("filters");
  });
});
