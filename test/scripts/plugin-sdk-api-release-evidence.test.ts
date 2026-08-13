import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPluginSdkApiReleaseEvidence,
  validatePluginSdkApiReleaseEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function diff(exports: unknown[] = []) {
  const payload = { entrypointsAdded: [], entrypointsRemoved: [], exports };
  return {
    ...payload,
    digest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
}

function evidence(exports: unknown[] = []) {
  return createPluginSdkApiReleaseEvidence({
    baseRef: "v2026.8.1",
    baseSha,
    diff: diff(exports),
    headSha,
  });
}

describe("Plugin SDK API release evidence", () => {
  it("rejects blank and mismatched acknowledgements before accepting the reported digest", () => {
    const receipt = evidence([{ change: "added", exportName: "send" }]);
    const expected = receipt.digest.slice(0, 8);
    const validate = (acknowledgement: string) =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement,
        evidence: receipt,
        expectedHeadSha: headSha,
        targetPackage: { scripts: { "plugin-sdk:api:diff": "node diff.mjs" } },
      });

    expect(() => validate("")).toThrow(`require acknowledgement digest ${expected}`);
    expect(() => validate("deadbeef")).toThrow(`require acknowledgement digest ${expected}`);
    expect(validate(expected)).toMatchObject({ acknowledgement: expected, hasChanges: true });
  });

  it("accepts a blank acknowledgement when the frozen diff has no changes", () => {
    expect(
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        evidence: evidence(),
        expectedHeadSha: headSha,
        targetPackage: { scripts: { "plugin-sdk:api:diff": "node diff.mjs" } },
      }),
    ).toMatchObject({ acknowledgement: null, hasChanges: false });
  });

  it("rejects evidence for another release SHA or a changed diff payload", () => {
    const receipt = evidence([{ change: "added", exportName: "send" }]);
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: receipt.digest.slice(0, 8),
        evidence: receipt,
        expectedHeadSha: "c".repeat(40),
        targetPackage: { scripts: { "plugin-sdk:api:diff": "node diff.mjs" } },
      }),
    ).toThrow("head SHA does not match");

    const changed = structuredClone(receipt);
    changed.diff.exports.push({ change: "removed", exportName: "receive" });
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: receipt.digest.slice(0, 8),
        evidence: changed,
        expectedHeadSha: headSha,
        targetPackage: { scripts: { "plugin-sdk:api:diff": "node diff.mjs" } },
      }),
    ).toThrow("digest does not match");
  });

  it("permits unavailable evidence only for historical targets without the diff command", () => {
    const unavailable = {
      schema: "openclaw.plugin-sdk-api-release-evidence/v1",
      status: "unavailable",
      headSha,
    };
    expect(
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        evidence: unavailable,
        expectedHeadSha: headSha,
        targetPackage: { scripts: { "plugin-sdk:api:check": "node legacy.mjs" } },
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        evidence: unavailable,
        expectedHeadSha: headSha,
        targetPackage: { scripts: { "plugin-sdk:api:diff": "node diff.mjs" } },
      }),
    ).toThrow("cannot be unavailable for a current release target");
  });
});
