import { isDeepStrictEqual } from "node:util";
import { INCLUDE_KEY } from "../../../config/includes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isRecord } from "../../../utils.js";

export function containsAuthoredInclude(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsAuthoredInclude);
  }
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, INCLUDE_KEY) || Object.values(record).some(containsAuthoredInclude);
}

export function isSingleTopLevelIncludeMigration(params: {
  parsed: unknown;
  sourceConfig: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  if (!isRecord(params.parsed)) {
    return false;
  }
  const keys = new Set([...Object.keys(params.sourceConfig), ...Object.keys(params.candidate)]);
  const sourceConfig = params.sourceConfig as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  const changed = [...keys].filter((key) => !isDeepStrictEqual(sourceConfig[key], candidate[key]));
  const changedKey = changed.length === 1 ? changed[0] : undefined;
  if (changedKey === undefined) {
    return false;
  }
  const authoredSection = params.parsed[changedKey];
  return (
    isRecord(authoredSection) &&
    Object.keys(authoredSection).length === 1 &&
    typeof authoredSection[INCLUDE_KEY] === "string"
  );
}
