import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginSdkApiReleaseEvidence,
  validatePluginSdkApiReleaseEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const workflowSha = "d".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    workflowSha,
  });
}

describe("Plugin SDK API release evidence", () => {
  it("preserves the frozen v1 payload digest and receipt bytes", () => {
    const legacyDiff = diff([{ change: "added", exportName: "send" }]);
    const receipt = createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.8.1",
      baseSha,
      diff: legacyDiff,
      headSha,
      workflowSha,
    });

    expect(legacyDiff.digest).toBe(
      "f4b495f34f8c1b72721841242b24d6f8351524c00e34db016af0fd3944f44992",
    );
    expect(JSON.stringify(receipt)).toBe(
      `{"schema":"openclaw.plugin-sdk-api-release-evidence/v1","status":"checked","baseRef":"v2026.8.1","baseSha":"${baseSha}","headSha":"${headSha}","hasChanges":true,"digest":"f4b495f34f8c1b72721841242b24d6f8351524c00e34db016af0fd3944f44992","diff":{"entrypointsAdded":[],"entrypointsRemoved":[],"exports":[{"change":"added","exportName":"send"}],"digest":"f4b495f34f8c1b72721841242b24d6f8351524c00e34db016af0fd3944f44992"},"workflowSha":"${workflowSha}"}`,
    );
    expect(
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: legacyDiff.digest.slice(0, 8),
        evidence: receipt,
        expectedHeadSha: headSha,
        expectedWorkflowSha: workflowSha,
      }),
    ).toMatchObject({ acknowledgement: "f4b495f3", hasChanges: true });
  });

  it("enforces acknowledgement through the release CLI", () => {
    const receipt = evidence([{ change: "added", exportName: "send" }]);
    const manifestPath = join(tempDirs.make("plugin-sdk-evidence-"), "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ pluginSdkApi: receipt }));
    const run = (acknowledgement?: string) =>
      spawnSync(
        process.execPath,
        [
          "scripts/plugin-sdk-api-release-evidence.mjs",
          "--manifest",
          manifestPath,
          "--head",
          headSha,
          "--workflow-sha",
          workflowSha,
          ...(acknowledgement ? ["--acknowledge", acknowledgement] : []),
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

    expect(run().stderr).toContain("require acknowledgement digest");
    expect(run("deadbeef").stderr).toContain("require acknowledgement digest");
    const accepted = run(receipt.digest.slice(0, 8));
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ hasChanges: true, status: "checked" });
  });

  it("rejects blank and mismatched acknowledgements before accepting the reported digest", () => {
    const receipt = evidence([{ change: "added", exportName: "send" }]);
    const expected = receipt.digest.slice(0, 8);
    const validate = (acknowledgement: string) =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement,
        evidence: receipt,
        expectedHeadSha: headSha,
        expectedWorkflowSha: workflowSha,
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
        expectedWorkflowSha: workflowSha,
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
        expectedWorkflowSha: workflowSha,
      }),
    ).toThrow("head SHA does not match");

    const changed = structuredClone(receipt);
    changed.diff.exports.push({ change: "removed", exportName: "receive" });
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: receipt.digest.slice(0, 8),
        evidence: changed,
        expectedHeadSha: headSha,
        expectedWorkflowSha: workflowSha,
      }),
    ).toThrow("digest does not match");
  });

  it("rejects a preflight receipt when the npm dist-tag predecessor moved", () => {
    const receipt = evidence();
    const validate = (currentSelectorRef: string, currentSelectorSha: string) =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        currentSelectorRef,
        currentSelectorSha,
        evidence: receipt,
        expectedHeadSha: headSha,
        expectedWorkflowSha: workflowSha,
        targetRef: "v2026.8.2",
      });

    expect(validate("v2026.8.1", baseSha)).toMatchObject({ status: "checked" });
    expect(() => validate("v2026.8.1-1", "c".repeat(40))).toThrow(
      "predecessor no longer matches the npm dist-tag",
    );
    expect(validate("v2026.8.2", headSha)).toMatchObject({ status: "checked" });
    expect(() => validate("v2026.8.2", "c".repeat(40))).toThrow(
      "dist-tag target does not match the release SHA",
    );
  });

  it("rejects untrusted tooling and unavailable evidence", () => {
    const receipt = evidence();
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        evidence: receipt,
        expectedHeadSha: headSha,
        expectedWorkflowSha: undefined,
      }),
    ).toThrow("Expected Plugin SDK API evidence workflow SHA");
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        evidence: receipt,
        expectedHeadSha: headSha,
        expectedWorkflowSha: "f".repeat(40),
      }),
    ).toThrow("workflow SHA does not match trusted tooling");
    expect(() =>
      validatePluginSdkApiReleaseEvidence({
        acknowledgement: "",
        evidence: { ...receipt, status: "unavailable" },
        expectedHeadSha: headSha,
        expectedWorkflowSha: workflowSha,
      }),
    ).toThrow("invalid status");
  });
});
