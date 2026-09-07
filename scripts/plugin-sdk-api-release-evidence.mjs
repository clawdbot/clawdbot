#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_SDK_API_RELEASE_EVIDENCE_SCHEMA = "openclaw.plugin-sdk-api-release-evidence/v1";
const PLUGIN_SDK_API_RELEASE_EVIDENCE_SET_SCHEMA =
  "openclaw.plugin-sdk-api-release-evidence-set/v1";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

// Release workflows fetch this file directly from their trusted workflow SHA,
// so it must stay runnable without a workspace install.
function isReleaseEvidenceObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
}

function diffPayload(diff) {
  if (
    !isReleaseEvidenceObject(diff) ||
    !Array.isArray(diff.entrypointsAdded) ||
    !Array.isArray(diff.entrypointsRemoved) ||
    !Array.isArray(diff.exports) ||
    typeof diff.digest !== "string" ||
    !DIGEST_PATTERN.test(diff.digest)
  ) {
    throw new Error("Plugin SDK API release evidence contains an invalid diff");
  }
  return {
    entrypointsAdded: diff.entrypointsAdded,
    entrypointsRemoved: diff.entrypointsRemoved,
    exports: diff.exports,
  };
}

function hasChanges(payload) {
  return (
    payload.entrypointsAdded.length > 0 ||
    payload.entrypointsRemoved.length > 0 ||
    payload.exports.length > 0
  );
}

export function createPluginSdkApiReleaseEvidence({
  baseRef,
  baseSha,
  diff,
  headSha,
  workflowSha,
}) {
  assertSha(baseSha, "Plugin SDK API evidence base SHA");
  assertSha(headSha, "Plugin SDK API evidence head SHA");
  assertSha(workflowSha, "Plugin SDK API evidence workflow SHA");
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    throw new Error("Plugin SDK API evidence base ref is required");
  }
  const payload = diffPayload(diff);
  const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  if (diff.digest !== digest) {
    throw new Error("Plugin SDK API diff digest does not match its payload");
  }
  return {
    schema: PLUGIN_SDK_API_RELEASE_EVIDENCE_SCHEMA,
    status: "checked",
    baseRef,
    baseSha,
    headSha,
    hasChanges: hasChanges(payload),
    digest,
    diff,
    workflowSha,
  };
}

export function selectPluginSdkApiReleaseEvidence({ evidence, npmDistTag }) {
  if (evidence?.schema !== PLUGIN_SDK_API_RELEASE_EVIDENCE_SET_SCHEMA) {
    return evidence;
  }
  const selectors = evidence.selectors;
  if (
    Object.keys(evidence).length !== 2 ||
    !isReleaseEvidenceObject(selectors) ||
    Object.keys(selectors).length !== 2 ||
    ["beta", "latest"].some(
      (selector) => selectors[selector]?.schema !== PLUGIN_SDK_API_RELEASE_EVIDENCE_SCHEMA,
    ) ||
    selectors.beta.headSha !== selectors.latest.headSha ||
    selectors.beta.workflowSha !== selectors.latest.workflowSha
  ) {
    throw new Error(
      "Plugin SDK API selector evidence must bind beta and latest to one release and tooling SHA",
    );
  }
  if (npmDistTag !== "beta" && npmDistTag !== "latest") {
    throw new Error("Plugin SDK API selector evidence requires the beta or latest npm dist-tag");
  }
  return selectors[npmDistTag];
}

export function createPluginSdkApiReleaseEvidenceSet(selectors) {
  const evidence = { schema: PLUGIN_SDK_API_RELEASE_EVIDENCE_SET_SCHEMA, selectors };
  selectPluginSdkApiReleaseEvidence({ evidence, npmDistTag: "beta" });
  return evidence;
}

export function validatePluginSdkApiReleaseEvidence({
  acknowledgement,
  currentSelectorRef = "",
  currentSelectorSha = "",
  evidence: inputEvidence,
  expectedHeadSha,
  expectedWorkflowSha,
  npmDistTag = "",
  targetRef = "",
}) {
  const evidence = selectPluginSdkApiReleaseEvidence({ evidence: inputEvidence, npmDistTag });
  assertSha(expectedHeadSha, "Expected Plugin SDK API evidence head SHA");
  if (
    !isReleaseEvidenceObject(evidence) ||
    evidence.schema !== PLUGIN_SDK_API_RELEASE_EVIDENCE_SCHEMA
  ) {
    throw new Error("Plugin SDK API release evidence is missing or invalid");
  }
  assertSha(evidence.workflowSha, "Plugin SDK API evidence workflow SHA");
  assertSha(expectedWorkflowSha, "Expected Plugin SDK API evidence workflow SHA");
  if (evidence.workflowSha !== expectedWorkflowSha) {
    throw new Error("Plugin SDK API evidence workflow SHA does not match trusted tooling");
  }
  if (evidence.status !== "checked") {
    throw new Error("Plugin SDK API release evidence has an invalid status");
  }
  assertSha(evidence.baseSha, "Plugin SDK API evidence base SHA");
  assertSha(evidence.headSha, "Plugin SDK API evidence head SHA");
  if (evidence.headSha !== expectedHeadSha) {
    throw new Error("Plugin SDK API evidence head SHA does not match the release");
  }
  if (typeof evidence.baseRef !== "string" || evidence.baseRef.length === 0) {
    throw new Error("Plugin SDK API evidence base ref is missing");
  }
  const selectorValues = [currentSelectorRef, currentSelectorSha, targetRef];
  const selectorValueCount = selectorValues.filter((value) => value !== "").length;
  if (selectorValueCount !== 0 && selectorValueCount !== selectorValues.length) {
    throw new Error("Current Plugin SDK API selector validation is incomplete");
  }
  if (selectorValueCount > 0) {
    if (
      typeof currentSelectorRef !== "string" ||
      currentSelectorRef.length === 0 ||
      typeof targetRef !== "string" ||
      targetRef.length === 0
    ) {
      throw new Error("Current Plugin SDK API selector refs are invalid");
    }
    assertSha(currentSelectorSha, "Current Plugin SDK API selector SHA");
    if (currentSelectorRef === targetRef && currentSelectorSha !== expectedHeadSha) {
      throw new Error("Current npm dist-tag target does not match the release SHA");
    }
    if (
      currentSelectorRef !== targetRef &&
      (evidence.baseRef !== currentSelectorRef || evidence.baseSha !== currentSelectorSha)
    ) {
      throw new Error("Plugin SDK API evidence predecessor no longer matches the npm dist-tag");
    }
  }
  const payload = diffPayload(evidence.diff);
  const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  if (evidence.digest !== digest || evidence.diff.digest !== digest) {
    throw new Error("Plugin SDK API release evidence digest does not match its diff");
  }
  const changed = hasChanges(payload);
  if (evidence.hasChanges !== changed) {
    throw new Error("Plugin SDK API release evidence change state does not match its diff");
  }
  const expectedAcknowledgement = digest.slice(0, 8);
  if (changed && acknowledgement !== expectedAcknowledgement) {
    throw new Error(
      `Plugin SDK API changes require acknowledgement digest ${expectedAcknowledgement}`,
    );
  }
  return {
    acknowledgement: changed ? expectedAcknowledgement : null,
    digest,
    hasChanges: changed,
    status: "checked",
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: plugin-sdk-api-release-evidence --manifest <path> --head <sha> --workflow-sha <sha> [--npm-dist-tag <tag>] [--acknowledge <digest>] [--current-selector-ref <tag> --current-selector-sha <sha> --target-ref <tag>]",
      );
    }
    values.set(flag, value);
  }
  for (const flag of ["--manifest", "--head", "--workflow-sha"]) {
    if (!values.has(flag)) {
      throw new Error(`${flag} is required`);
    }
  }
  return values;
}

function main() {
  const args = readArgs(process.argv.slice(2));
  const manifest = readJson(args.get("--manifest"));
  const result = validatePluginSdkApiReleaseEvidence({
    acknowledgement: args.get("--acknowledge") ?? "",
    currentSelectorRef: args.get("--current-selector-ref"),
    currentSelectorSha: args.get("--current-selector-sha"),
    evidence: manifest.pluginSdkApi,
    expectedHeadSha: args.get("--head"),
    expectedWorkflowSha: args.get("--workflow-sha"),
    npmDistTag: args.get("--npm-dist-tag"),
    targetRef: args.get("--target-ref"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
