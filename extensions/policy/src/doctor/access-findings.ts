import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CHECK_IDS } from "./check-ids.js";
import { SUPPORTED_AUTH_PROFILE_METADATA } from "./policy-constants.js";
import { isChannelDenyRule } from "./policy-runtime.js";
import { unsupportedPolicyKey } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function authProfileMetadataRequirementFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.auth) ||
    !isRecord(policy.auth.profiles) ||
    policy.auth.profiles.requireMetadata === undefined
  ) {
    return [];
  }
  if (!Array.isArray(policy.auth.profiles.requireMetadata)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} auth.profiles.requireMetadata must be an array of metadata keys.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/auth/profiles/requireMetadata`,
        fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`,
      },
    ];
  }
  const invalidIndex = policy.auth.profiles.requireMetadata.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_AUTH_PROFILE_METADATA.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} auth.profiles.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/auth/profiles/requireMetadata/#${invalidIndex}`,
      fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`,
    },
  ];
}

export function invalidChannelDenyRuleFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.channels) || policy.channels.denyRules === undefined) {
    return [];
  }
  if (!Array.isArray(policy.channels.denyRules)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} channels.denyRules must be an array.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/channels/denyRules`,
        fixHint: `Fix ${policyPath} so channel deny rules are an array.`,
      },
    ];
  }
  for (const [index, rule] of policy.channels.denyRules.entries()) {
    if (!isRecord(rule)) {
      continue;
    }
    const unsupportedRuleKey = unsupportedPolicyKey(rule, ["id", "reason", "when"]);
    if (unsupportedRuleKey !== undefined) {
      return [
        {
          checkId: CHECK_IDS.policyInvalidFile,
          severity: "error",
          message: `${policyPath} channels.denyRules[${index}].${unsupportedRuleKey} is not supported in channel deny rules.`,
          source: "policy",
          path: policyPath,
          target: `oc://${policyDocName}/channels/denyRules/#${index}/${ocPathSegment(unsupportedRuleKey)}`,
          fixHint: `Remove channels.denyRules[${index}].${unsupportedRuleKey} or use id, when.provider, and reason.`,
        },
      ];
    }
    if (isRecord(rule.when)) {
      const unsupportedWhenKey = unsupportedPolicyKey(rule.when, ["provider"]);
      if (unsupportedWhenKey !== undefined) {
        return [
          {
            checkId: CHECK_IDS.policyInvalidFile,
            severity: "error",
            message: `${policyPath} channels.denyRules[${index}].when.${unsupportedWhenKey} is not supported in channel deny rules.`,
            source: "policy",
            path: policyPath,
            target: `oc://${policyDocName}/channels/denyRules/#${index}/when/${ocPathSegment(unsupportedWhenKey)}`,
            fixHint: `Remove channels.denyRules[${index}].when.${unsupportedWhenKey} or use when.provider.`,
          },
        ];
      }
    }
  }
  const invalid = policy.channels.denyRules.findIndex((rule) => !isChannelDenyRule(rule));
  if (invalid < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} channels.denyRules[${invalid}] must define when.provider as a string.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/channels/denyRules/#${invalid}`,
      fixHint: `Fix ${policyPath} so each channel deny rule has a provider match.`,
    },
  ];
}
