import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CHECK_IDS } from "./check-ids.js";
import { ocPathSegment } from "./utils.js";

export function unsupportedPolicyKey(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): string | undefined {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).find((key) => !allowed.has(key));
}

export function policyStringArrayShapeFinding(
  value: unknown,
  params: {
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
    readonly valueName: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an object.`,
      `Fix ${params.policyPath} so ${params.property} is an object.`,
    );
  }
  const unsupportedKey = unsupportedPolicyKey(value, ["allow", "deny"]);
  if (unsupportedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}/${ocPathSegment(unsupportedKey)}`,
      `${params.policyPath} ${params.property}.${unsupportedKey} is not supported in policy.`,
      `Remove ${params.property}.${unsupportedKey} or use ${params.property}.allow or ${params.property}.deny.`,
    );
  }
  for (const key of ["allow", "deny"] as const) {
    const entries = value[key];
    if (entries === undefined) {
      continue;
    }
    const target = `oc://${params.policyDocName}/${params.target}/${key}`;
    if (!Array.isArray(entries)) {
      return policyShapeFinding(
        params.policyPath,
        target,
        `${params.policyPath} ${params.property}.${key} must be an array.`,
        `Fix ${params.policyPath} so ${params.property}.${key} is an array of ${params.valueName}s.`,
      );
    }
    const invalidIndex = entries.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `${target}/#${invalidIndex}`,
        `${params.policyPath} ${params.property}.${key}[${invalidIndex}] must be a non-empty string.`,
        `Fix ${params.policyPath} so each ${params.property}.${key} entry is a ${params.valueName}.`,
      );
    }
  }
  return undefined;
}

export function policyStringArrayPropertyShapeFinding(
  value: unknown,
  params: {
    readonly allowed?: readonly string[];
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
    readonly valueName: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an array.`,
      `Fix ${params.policyPath} so ${params.property} is an array of ${params.valueName}s.`,
    );
  }
  const invalidIndex = value.findIndex((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      return true;
    }
    return params.allowed !== undefined && !params.allowed.includes(entry.trim());
  });
  if (invalidIndex < 0) {
    return undefined;
  }
  const allowedHint =
    params.allowed === undefined ? "" : ` Supported values: ${params.allowed.join(", ")}.`;
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.target}/#${invalidIndex}`,
    `${params.policyPath} ${params.property}[${invalidIndex}] must be a supported ${params.valueName}.`,
    `Use non-empty ${params.valueName} entries.${allowedHint}`,
  );
}

export function policyShapeFinding(
  policyPath: string,
  target: string,
  message: string,
  fixHint: string,
): HealthFinding {
  return {
    checkId: CHECK_IDS.policyInvalidFile,
    severity: "error",
    message,
    source: "policy",
    path: policyPath,
    target,
    fixHint,
  };
}
