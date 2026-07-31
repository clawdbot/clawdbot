import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ConfigUiHints } from "../../api/types.ts";
import {
  countSensitiveConfigValues,
  hintForPath,
  isSensitiveConfigPath,
  redactedPlaceholder,
} from "../../components/config-form.shared.ts";
import { t } from "../../i18n/index.ts";
import { isJson5Warm, parseJson5Text } from "../../lib/json5-runtime.ts";
import type { ConfigDiffEntry, ConfigDiffPath, ConfigViewState } from "./view-types.ts";

const MAX_CONFIG_DIFF_DEPTH = 64;
const MAX_CONFIG_DIFF_NODES = 20_000;
const MAX_CONFIG_DIFF_CHANGES = 1_000;
const MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS = 2_000;
const MAX_RAW_DIFF_CHARS = 200_000;

export function formatConfigDiffPath(path: ConfigDiffPath): string {
  return path.length > 0 ? path.join(".") : t("configView.root");
}

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): ConfigDiffEntry[] {
  if (!original || !current) {
    return [];
  }
  const changes: ConfigDiffEntry[] = [];
  let visited = 0;

  function pushChange(path: ConfigDiffPath, from: unknown, to: unknown) {
    if (changes.length < MAX_CONFIG_DIFF_CHANGES) {
      changes.push({ path, from, to });
    }
  }

  function arrayValuesDiffer(orig: unknown[], curr: unknown[], depth: number): boolean {
    if (orig.length !== curr.length) {
      return true;
    }
    if (orig.length > MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS) {
      return true;
    }
    for (let index = 0; index < orig.length; index += 1) {
      if (valuesDiffer(orig[index], curr[index], depth + 1)) {
        return true;
      }
    }
    return false;
  }

  function objectValuesDiffer(
    orig: Record<string, unknown>,
    curr: Record<string, unknown>,
    depth: number,
  ): boolean {
    const origKeys = Object.keys(orig);
    const currKeys = Object.keys(curr);
    if (origKeys.length !== currKeys.length) {
      return true;
    }
    for (const key of origKeys) {
      if (!Object.hasOwn(curr, key) || valuesDiffer(orig[key], curr[key], depth + 1)) {
        return true;
      }
    }
    return false;
  }

  function valuesDiffer(orig: unknown, curr: unknown, depth: number): boolean {
    visited += 1;
    if (visited > MAX_CONFIG_DIFF_NODES || depth > MAX_CONFIG_DIFF_DEPTH) {
      return true;
    }
    if (orig === curr) {
      return false;
    }
    if (typeof orig !== typeof curr) {
      return true;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      return orig !== curr;
    }
    if (Array.isArray(orig) || Array.isArray(curr)) {
      return Array.isArray(orig) && Array.isArray(curr)
        ? arrayValuesDiffer(orig, curr, depth + 1)
        : true;
    }
    return objectValuesDiffer(
      orig as Record<string, unknown>,
      curr as Record<string, unknown>,
      depth + 1,
    );
  }

  function compare(orig: unknown, curr: unknown, path: ConfigDiffPath, depth: number) {
    visited += 1;
    if (
      visited > MAX_CONFIG_DIFF_NODES ||
      depth > MAX_CONFIG_DIFF_DEPTH ||
      changes.length >= MAX_CONFIG_DIFF_CHANGES
    ) {
      return;
    }
    if (orig === curr) {
      return;
    }
    if (typeof orig !== typeof curr) {
      pushChange(path, orig, curr);
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        pushChange(path, orig, curr);
      }
      return;
    }
    if (Array.isArray(orig) || Array.isArray(curr)) {
      if (Array.isArray(orig) && Array.isArray(curr) && arrayValuesDiffer(orig, curr, depth + 1)) {
        pushChange(path, orig, curr);
      } else if (!Array.isArray(orig) || !Array.isArray(curr)) {
        pushChange(path, orig, curr);
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], [...path, key], depth + 1);
    }
  }

  compare(original, current, [], 0);
  return changes;
}

export function computeRawDiff(
  viewState: ConfigViewState,
  original: string,
  current: string,
): ConfigDiffEntry[] {
  if (viewState.rawDiffCache?.original === original && viewState.rawDiffCache.current === current) {
    return viewState.rawDiffCache.diff;
  }
  if (original.length > MAX_RAW_DIFF_CHARS || current.length > MAX_RAW_DIFF_CHARS) {
    viewState.rawDiffCache = { original, current, diff: [] };
    return viewState.rawDiffCache.diff;
  }
  try {
    const originalValue = parseJson5Text(original);
    const currentValue = parseJson5Text(current);
    if (
      !originalValue ||
      !currentValue ||
      typeof originalValue !== "object" ||
      typeof currentValue !== "object" ||
      Array.isArray(originalValue) ||
      Array.isArray(currentValue)
    ) {
      viewState.rawDiffCache = { original, current, diff: [] };
      return [];
    }
    const diff = computeDiff(
      originalValue as Record<string, unknown>,
      currentValue as Record<string, unknown>,
    );
    viewState.rawDiffCache = { original, current, diff };
    return diff;
  } catch {
    // While the lazy JSON5 parser is still loading, a parse failure may be
    // transient; skip the cache so the next render retries instead of pinning
    // an empty diff for this text pair.
    if (isJson5Warm()) {
      viewState.rawDiffCache = { original, current, diff: [] };
    }
    return [];
  }
}

function truncateValue(value: unknown, maxLen = 40): string {
  if (Array.isArray(value)) {
    return t(value.length === 1 ? "configView.itemCount" : "configView.itemCountPlural", {
      count: String(value.length),
    });
  }
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) {
    return str;
  }
  return truncateUtf16Safe(str, maxLen - 3) + "...";
}

function hintKeyMatchesPathPrefix(hintKey: string, path: ConfigDiffPath): boolean {
  const hintSegments = hintKey.split(".");
  if (hintSegments.length !== path.length) {
    return false;
  }
  return hintSegments.every((segment, index) => segment === "*" || segment === path[index]);
}

function hasSensitiveHintForPathPrefix(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  return Object.entries(uiHints).some(
    ([hintKey, hint]) => Boolean(hint.sensitive) && hintKeyMatchesPathPrefix(hintKey, path),
  );
}

function isSensitiveDiffPath(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  for (let index = 1; index <= path.length; index += 1) {
    const prefix = path.slice(0, index);
    const key = formatConfigDiffPath(prefix);
    if (
      (hintForPath(prefix, uiHints)?.sensitive ?? false) ||
      hasSensitiveHintForPathPrefix(prefix, uiHints) ||
      isSensitiveConfigPath(key)
    ) {
      return true;
    }
  }
  return false;
}

export function renderRawDiffValue(
  path: ConfigDiffPath,
  value: unknown,
  uiHints: ConfigUiHints,
  rawRevealed: boolean,
): string {
  const hasSensitiveValue = countSensitiveConfigValues(value, path, uiHints) > 0;
  if (!rawRevealed && value != null && (isSensitiveDiffPath(path, uiHints) || hasSensitiveValue)) {
    return redactedPlaceholder();
  }
  return truncateValue(value);
}
