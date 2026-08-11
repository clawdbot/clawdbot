// Redacts runtime config snapshots before diagnostics or UI exposure.
import {
  hasSensitiveUrlHintTag,
  isSensitiveUrlConfigPath,
  redactSensitiveUrlLikeString,
} from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { normalizeManifestChannelId } from "./channel-claimant-plugins.js";
import { containsEnvVarReference } from "./env-substitution.js";
import {
  replaceSensitiveValuesInRaw,
  shouldFallbackToStructuredRawRedaction,
} from "./redact-snapshot.raw.js";
import { isSecretRefShape, redactSecretRefId } from "./redact-snapshot.secret-ref.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

const log = createSubsystemLogger("config/redaction");
const ENV_VAR_PLACEHOLDER_PATTERN = /^\$\{[^}]*\}$/;

function isSensitivePath(path: string): boolean {
  if (path.endsWith("[]")) {
    return isSensitiveConfigPath(path.slice(0, -2));
  }
  return isSensitiveConfigPath(path);
}

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_PATTERN.test(value.trim());
}

function isWholeObjectSensitivePath(path: string): boolean {
  const lowered = normalizeLowercaseStringOrEmpty(path);
  return lowered.endsWith("serviceaccount") || lowered.endsWith("serviceaccountref");
}

function isSensitiveUrlPath(path: string): boolean {
  return isSensitiveUrlConfigPath(path);
}

function hasSensitiveUrlHintPath(hints: ConfigUiHints | undefined, paths: string[]): boolean {
  if (!hints) {
    return false;
  }
  return paths.some((path) => hasSensitiveUrlHintTag(hints[path]));
}

function collectSensitiveStrings(value: unknown, values: string[]): void {
  if (typeof value === "string") {
    if (!isEnvVarPlaceholder(value)) {
      values.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveStrings(item, values);
    }
    return;
  }
  if (isObjectRecord(value)) {
    const obj = value;
    // SecretRef objects include structural fields like source/provider that are
    // not secret material and may appear widely in config text.
    if (isSecretRefShape(obj)) {
      if (!isEnvVarPlaceholder(obj.id)) {
        values.push(obj.id);
      }
      return;
    }
    for (const item of Object.values(obj)) {
      collectSensitiveStrings(item, values);
    }
  }
}

function isExplicitlyNonSensitivePath(hints: ConfigUiHints | undefined, paths: string[]): boolean {
  if (!hints) {
    return false;
  }
  return paths.some((path) => hints[path]?.sensitive === false);
}

/**
 * Sentinel value used to replace sensitive config fields in gateway responses.
 * Write-side handlers (config.set, config.apply, config.patch) detect this
 * sentinel and restore the original value from the on-disk config, so a
 * round-trip through the Web UI does not corrupt credentials.
 */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

function isSecretRefWithProvider(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { source: string; provider: string; id: string } {
  return isSecretRefShape(value) && typeof value.provider === "string";
}

// ConfigUiHints' keys look like this:
// - path.subpath.key (nested objects)
// - path.subpath[].key (object in array in object)
// - path.*.key (object in record in object)
// records are handled by the lookup, but arrays need two entries in
// the Set, as their first lookup is done before the code knows it's
// an array.
function buildRedactionLookup(hints: ConfigUiHints): Set<string> {
  const result = new Set<string>();

  for (const [path, hint] of Object.entries(hints)) {
    if (!hint.sensitive) {
      continue;
    }

    const parts = path.split(".");
    let joinedPath = parts.shift() ?? "";
    result.add(joinedPath);
    if (joinedPath.endsWith("[]")) {
      result.add(joinedPath.slice(0, -2));
    }

    for (const part of parts) {
      if (part.endsWith("[]")) {
        result.add(`${joinedPath}.${part.slice(0, -2)}`);
      }
      // hey, greptile, notice how this is *NOT* in an else block?
      joinedPath = `${joinedPath}.${part}`;
      result.add(joinedPath);
    }
  }
  if (result.size !== 0) {
    result.add("");
  }
  return result;
}

type RedactionContext = {
  hints: ConfigUiHints | undefined;
  lookup: ReadonlySet<string> | undefined;
};

function createRedactionContext(hints?: ConfigUiHints): RedactionContext {
  const lookup = hints ? buildRedactionLookup(hints) : undefined;
  return { hints, lookup: lookup?.has("") ? lookup : undefined };
}

// Schema lookup coverage is prefix-scoped. After a path misses, heuristic detection must own the
// whole subtree so dynamic plugin, channel, and env keys cannot escape redaction or restoration.
function withoutRedactionLookup(context: RedactionContext): RedactionContext {
  return context.lookup ? { hints: context.hints, lookup: undefined } : context;
}

/** Deep-walk an object and replace values at sensitive paths with the redaction sentinel. */
function redactObject<T>(obj: T, hints?: ConfigUiHints): T {
  return redactValue(obj, "", [], createRedactionContext(hints)) as T;
}

/**
 * Collect all sensitive string values from a config object.
 * Used for text-based redaction of the raw JSON5 source.
 */
function collectSensitiveValues(obj: unknown, hints?: ConfigUiHints): string[] {
  const result: string[] = [];
  redactValue(obj, "", result, createRedactionContext(hints));
  return result;
}

function redactValue(
  obj: unknown,
  prefix: string,
  values: string[],
  context: RedactionContext,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    const path = `${prefix}[]`;
    const schemaMatched = context.lookup?.has(path) === true;
    const fallbackContext = schemaMatched ? context : withoutRedactionLookup(context);
    const heuristicSensitive =
      !isExplicitlyNonSensitivePath(context.hints, [path]) && isSensitivePath(path);
    return obj.map((item) => {
      if (
        typeof item === "string" &&
        !isEnvVarPlaceholder(item) &&
        (schemaMatched || heuristicSensitive)
      ) {
        values.push(item);
        return REDACTED_SENTINEL;
      }
      return redactValue(item, path, values, fallbackContext);
    });
  }

  if (!isObjectRecord(obj)) {
    return obj;
  }

  const result: Record<string, unknown> = {};
  const fallbackContext = withoutRedactionLookup(context);
  for (const [key, value] of Object.entries(obj)) {
    // Hint paths carry the CANONICAL channel id while validation admits declared variant
    // spellings as authored keys — the lookup canonicalizes the channel segment so a plugin's
    // `sensitive: true` hint reaches every admitted spelling; output keys stay authored.
    const lookupKey = prefix === "channels" ? normalizeManifestChannelId(key) : key;
    const path = prefix ? `${prefix}.${lookupKey}` : key;
    const wildcardPath = prefix ? `${prefix}.*` : "*";
    const candidate = context.lookup
      ? [path, wildcardPath].find((entry) => context.lookup?.has(entry))
      : undefined;
    if (candidate) {
      result[key] = value;
      if (typeof value === "string" && !isEnvVarPlaceholder(value)) {
        result[key] = REDACTED_SENTINEL;
        values.push(value);
      } else if (typeof value === "object" && value !== null) {
        if (context.hints?.[candidate]?.sensitive === true && !Array.isArray(value)) {
          const objectValue = toObjectRecord(value);
          if (isSecretRefShape(objectValue)) {
            result[key] = redactSecretRefId({
              value: objectValue,
              values,
              redactedSentinel: REDACTED_SENTINEL,
              isEnvVarPlaceholder,
            });
          } else {
            collectSensitiveStrings(objectValue, values);
            result[key] = REDACTED_SENTINEL;
          }
        } else {
          result[key] = redactValue(value, candidate, values, context);
        }
      } else if (
        context.hints?.[candidate]?.sensitive === true &&
        value !== undefined &&
        value !== null
      ) {
        result[key] = REDACTED_SENTINEL;
      }
      continue;
    }

    const hintPaths = [path, wildcardPath];
    const markedNonSensitive = isExplicitlyNonSensitivePath(context.hints, hintPaths);
    if (
      typeof value === "string" &&
      !markedNonSensitive &&
      isSensitivePath(path) &&
      !isEnvVarPlaceholder(value)
    ) {
      result[key] = REDACTED_SENTINEL;
      values.push(value);
    } else if (
      !context.lookup &&
      !markedNonSensitive &&
      isSensitivePath(path) &&
      isWholeObjectSensitivePath(path) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      collectSensitiveStrings(value, values);
      result[key] = REDACTED_SENTINEL;
    } else if (
      typeof value === "string" &&
      (hasSensitiveUrlHintPath(context.hints, hintPaths) || isSensitiveUrlPath(path))
    ) {
      const scrubbed = redactSensitiveUrlLikeString(value);
      if (scrubbed !== value) {
        values.push(value);
        result[key] = REDACTED_SENTINEL;
      } else {
        result[key] = value;
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactValue(value, path, values, fallbackContext);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Replace known sensitive values in a raw JSON5 string with the sentinel.
 * Values are replaced longest-first to avoid partial matches.
 */
function redactRawText(raw: string, config: unknown, hints?: ConfigUiHints): string {
  const sensitiveValues = collectSensitiveValues(config, hints);
  return replaceSensitiveValuesInRaw({
    raw,
    sensitiveValues,
    redactedSentinel: REDACTED_SENTINEL,
  });
}

let suppressRestoreWarnings = false;

function withRestoreWarningsSuppressed<T>(fn: () => T): T {
  const prev = suppressRestoreWarnings;
  suppressRestoreWarnings = true;
  try {
    return fn();
  } finally {
    suppressRestoreWarnings = prev;
  }
}

/**
 * Redact sensitive fields from a plain config object (not a full snapshot).
 * Used by write endpoints (config.set, config.patch, config.apply) to avoid
 * leaking credentials in their responses.
 */
export function redactConfigObject<T>(value: T, uiHints?: ConfigUiHints): T {
  return redactObject(value, uiHints);
}

/**
 * Returns a copy of the config snapshot with all sensitive fields replaced by
 * {@link REDACTED_SENTINEL}. The `hash` is preserved because it tracks config identity.
 *
 * Both `config` (the parsed object) and `raw` (the JSON5 source) are scrubbed so no credential can
 * leak through either path. Schema hints determine sensitivity when supplied; otherwise path-based
 * detection applies.
 */
export function redactConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  uiHints?: ConfigUiHints,
): ConfigFileSnapshot {
  if (!snapshot.valid) {
    // This is bad. We could try to redact the raw string using known key names,
    // but then we would not be able to restore them, and would trash the user's
    // credentials. Less than ideal---we should never delete important data.
    // On the other hand, we cannot hand out "raw" if we're not sure we have
    // properly redacted all sensitive data. Handing out a partially or, worse,
    // unredacted config string would be bad.
    // Therefore, the only safe route is to reject handling out broken configs.
    const redactedConfig = {} as ConfigFileSnapshot["config"];
    const redactedResolved = {} as ConfigFileSnapshot["resolved"];
    return {
      ...snapshot,
      sourceConfig: redactedResolved,
      runtimeConfig: redactedConfig,
      config: redactedConfig,
      raw: null,
      parsed: null,
      resolved: redactedResolved,
    };
  }
  // else: snapshot.config must be valid and populated, as that is what
  // readConfigFileSnapshot() does when it creates the snapshot.

  const redactedConfig = redactObject(snapshot.config, uiHints);
  const redactedParsed = snapshot.parsed ? redactObject(snapshot.parsed, uiHints) : snapshot.parsed;
  let redactedRaw = snapshot.raw ? redactRawText(snapshot.raw, snapshot.config, uiHints) : null;
  if (
    redactedRaw &&
    shouldFallbackToStructuredRawRedaction({
      redactedRaw,
      originalConfig: snapshot.parsed ?? snapshot.config,
      restoreParsed: (parsed) =>
        withRestoreWarningsSuppressed(() =>
          restoreRedactedValues(parsed, snapshot.config, uiHints),
        ),
    })
  ) {
    redactedRaw = null;
  }
  // Also redact the resolved config (contains values after ${ENV} substitution)
  const redactedResolved = redactConfigObject(snapshot.resolved, uiHints);
  const { pluginMetadataSnapshot: _pluginMetadataSnapshot, ...publicSnapshot } =
    snapshot as typeof snapshot & {
      pluginMetadataSnapshot?: unknown;
    };

  return {
    ...publicSnapshot,
    sourceConfig: redactedResolved,
    runtimeConfig: redactedConfig,
    config: redactedConfig,
    raw: redactedRaw,
    parsed: redactedParsed,
    resolved: redactedResolved,
  };
}

type RedactionResult = {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  humanReadableMessage?: string;
};

/**
 * Deep-walk `incoming` and replace any {@link REDACTED_SENTINEL} values
 * (on sensitive paths) with the corresponding value from `original`.
 *
 * This is called by config.set / config.apply / config.patch before writing,
 * so that credentials survive a Web UI round-trip unmodified.
 */
export function restoreRedactedValues(
  incoming: unknown,
  original: unknown,
  hints?: ConfigUiHints,
): RedactionResult {
  if (incoming === null || incoming === undefined) {
    return { ok: false, error: "no input" };
  }
  if (typeof incoming !== "object") {
    return { ok: false, error: "input not an object" };
  }
  try {
    const restored = restoreRedactedValue(incoming, original, "", createRedactionContext(hints));
    assertNoRedactedSentinel(restored, "");
    return { ok: true, result: restored };
  } catch (err) {
    if (err instanceof RedactionError) {
      return {
        ok: false,
        humanReadableMessage: err.humanReadableMessage,
      };
    }
    throw err; // some coding error, pass through
  }
}

class RedactionError extends Error {
  public readonly key: string;
  public readonly humanReadableMessage: string;

  constructor(key: string, humanReadableMessage?: string) {
    super("internal error class---should never escape");
    this.key = key;
    this.humanReadableMessage =
      humanReadableMessage ??
      `Sentinel value "${REDACTED_SENTINEL}" in key ${key} is not valid as real data`;
    this.name = "RedactionError";
  }
}

function restoreOriginalValueOrThrow(params: {
  key: string;
  path: string;
  original: Record<string, unknown>;
}): unknown {
  if (Object.hasOwn(params.original, params.key)) {
    return params.original[params.key];
  }
  if (!suppressRestoreWarnings) {
    log.warn(`Cannot un-redact config key ${params.path} as it doesn't have any value`);
  }
  throw new RedactionError(params.path);
}

function assertNoRedactedSentinel(value: unknown, path: string): void {
  if (typeof value === "string" && value === REDACTED_SENTINEL) {
    const pathLabel = path || "<root>";
    throw new RedactionError(
      pathLabel,
      `Reserved redaction sentinel "${REDACTED_SENTINEL}" is not valid config data (${pathLabel}).`,
    );
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nextPath = path ? `${path}[${index}]` : `[${index}]`;
      assertNoRedactedSentinel(value[index], nextPath);
    }
    return;
  }
  if (isObjectRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertNoRedactedSentinel(item, path ? `${path}.${key}` : key);
    }
  }
}

function maybeRestoreSecretRefId(params: {
  incoming: unknown;
  original: unknown;
  path: string;
}): { handled: false } | { handled: true; value: unknown } {
  const incomingObj = toObjectRecord(params.incoming);
  if (!isSecretRefShape(incomingObj) || incomingObj.id !== REDACTED_SENTINEL) {
    return { handled: false };
  }

  const originalObj = toObjectRecord(params.original);
  if (!isSecretRefWithProvider(originalObj)) {
    // Automatic restore needs provider as part of the identity; source+id alone can match the
    // wrong secret provider after config edits.
    if (isSecretRefShape(originalObj)) {
      throw new RedactionError(
        params.path,
        `SecretRef at ${params.path} requires a provider field to restore the redacted id automatically (original ref lacks provider).`,
      );
    }
    throw new RedactionError(
      params.path,
      `SecretRef at ${params.path} contains a redacted id placeholder with no matching original value.`,
    );
  }

  if (!isSecretRefWithProvider(incomingObj)) {
    // A redacted id is only restorable when the incoming object still carries the stable SecretRef
    // identity fields that were visible in the redacted snapshot.
    throw new RedactionError(
      params.path,
      `SecretRef at ${params.path} must include source, provider, and id when redacted placeholders are present.`,
    );
  }

  if (incomingObj.source !== originalObj.source || incomingObj.provider !== originalObj.provider) {
    // Changing source/provider while keeping a redacted id would silently bind the old secret id to
    // a different backend. Require an explicit id for that edit.
    throw new RedactionError(
      params.path,
      `SecretRef at ${params.path} changed source/provider while id is redacted. Provide an explicit id when changing source/provider.`,
    );
  }

  return { handled: true, value: { ...incomingObj, id: originalObj.id } };
}

type RedactedArrayIdentity = {
  item: unknown;
  index: number;
  count: number;
};

function readRedactedArrayItemId(item: unknown): string | undefined {
  if (!isObjectRecord(item) || !Object.hasOwn(item, "id")) {
    return undefined;
  }
  const id = item.id;
  // Authored env references and escapes differ from their resolved snapshot identities.
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id === REDACTED_SENTINEL ||
    containsEnvVarReference(id) ||
    id.includes("$${")
  ) {
    return undefined;
  }
  return id;
}

function indexRedactedArrayItemsById(items: unknown[]): Map<string, RedactedArrayIdentity> {
  const itemsById = new Map<string, RedactedArrayIdentity>();
  for (const [index, item] of items.entries()) {
    const id = readRedactedArrayItemId(item);
    if (id === undefined) {
      continue;
    }
    const previous = itemsById.get(id);
    if (previous) {
      previous.count += 1;
    } else {
      itemsById.set(id, { item, index, count: 1 });
    }
  }
  return itemsById;
}

function mapRedactedArray(params: {
  incoming: unknown[];
  original: unknown;
  path: string;
  mapItem: (item: unknown, originalItem: unknown) => unknown;
}): unknown[] {
  const originalArray = Array.isArray(params.original) ? params.original : [];
  if (params.incoming.length < originalArray.length) {
    log.warn(`Redacted config array key ${params.path} has been truncated`);
  }
  const originalById = indexRedactedArrayItemsById(originalArray);
  const incomingById = indexRedactedArrayItemsById(params.incoming);
  const reservedOriginalIndexes = new Set<number>();
  for (const [id, incomingIdentity] of incomingById) {
    const originalIdentity = originalById.get(id);
    if (incomingIdentity.count === 1 && originalIdentity?.count === 1) {
      reservedOriginalIndexes.add(originalIdentity.index);
    }
  }
  const hasUniqueOriginalIdentity = Array.from(originalById.values()).some(
    (identity) => identity.count === 1,
  );

  return params.incoming.map((item, index) => {
    const id = readRedactedArrayItemId(item);
    const originalIdentity = id === undefined ? undefined : originalById.get(id);
    const incomingIdentity = id === undefined ? undefined : incomingById.get(id);
    if (incomingIdentity?.count === 1 && originalIdentity?.count === 1) {
      return params.mapItem(item, originalIdentity.item);
    }
    if (incomingIdentity?.count === 1 && !originalIdentity && hasUniqueOriginalIdentity) {
      return params.mapItem(item, undefined);
    }
    // Positional fallback must not reuse a secret already reserved for another identified entry.
    const originalItem = reservedOriginalIndexes.has(index) ? undefined : originalArray[index];
    return params.mapItem(item, originalItem);
  });
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  return isObjectRecord(value) ? value : {};
}

function restoreRedactedValue(
  incoming: unknown,
  original: unknown,
  prefix: string,
  context: RedactionContext,
): unknown {
  if (incoming === null || incoming === undefined || typeof incoming !== "object") {
    return incoming;
  }

  if (Array.isArray(incoming)) {
    const path = `${prefix}[]`;
    const schemaMatched = context.lookup?.has(path) === true;
    const fallbackContext = schemaMatched ? context : withoutRedactionLookup(context);
    const heuristicSensitive =
      !isExplicitlyNonSensitivePath(context.hints, [path]) && isSensitivePath(path);
    return mapRedactedArray({
      incoming,
      original,
      path,
      mapItem: (item, originalItem) =>
        item === REDACTED_SENTINEL && (schemaMatched || heuristicSensitive)
          ? originalItem
          : restoreRedactedValue(item, originalItem, path, fallbackContext),
    });
  }

  const orig = toObjectRecord(original);
  const result: Record<string, unknown> = {};
  const fallbackContext = withoutRedactionLookup(context);
  for (const [key, value] of Object.entries(toObjectRecord(incoming))) {
    // Mirrors the redaction walk: the channel segment canonicalizes for hint lookups so a
    // sentinel written under an authored variant spelling restores through the same canonical
    // hint that redacted it.
    const lookupKey = prefix === "channels" ? normalizeManifestChannelId(key) : key;
    const path = prefix ? `${prefix}.${lookupKey}` : key;
    const wildcardPath = prefix ? `${prefix}.*` : "*";
    const candidate = context.lookup
      ? [path, wildcardPath].find((entry) => context.lookup?.has(entry))
      : undefined;
    if (candidate) {
      if (
        value === REDACTED_SENTINEL &&
        (context.hints?.[candidate]?.sensitive === true ||
          hasSensitiveUrlHintPath(context.hints, [candidate, path, wildcardPath]) ||
          isSensitiveUrlPath(path))
      ) {
        result[key] = restoreOriginalValueOrThrow({ key, path: candidate, original: orig });
      } else if (typeof value === "object" && value !== null) {
        const restoredSecretRef = maybeRestoreSecretRefId({
          incoming: value,
          original: orig[key],
          path,
        });
        result[key] = restoredSecretRef.handled
          ? restoredSecretRef.value
          : restoreRedactedValue(value, orig[key], candidate, context);
      } else {
        result[key] = value;
      }
      continue;
    }

    const hintPaths = [path, wildcardPath];
    const canRestore =
      !isExplicitlyNonSensitivePath(context.hints, hintPaths) &&
      (isSensitivePath(path) ||
        hasSensitiveUrlHintPath(context.hints, hintPaths) ||
        isSensitiveUrlPath(path));
    if (value === REDACTED_SENTINEL && canRestore) {
      result[key] = restoreOriginalValueOrThrow({ key, path, original: orig });
    } else if (typeof value === "object" && value !== null) {
      const restoredSecretRef = canRestore
        ? maybeRestoreSecretRefId({ incoming: value, original: orig[key], path })
        : { handled: false as const };
      result[key] = restoredSecretRef.handled
        ? restoredSecretRef.value
        : restoreRedactedValue(value, orig[key], path, fallbackContext);
    } else {
      result[key] = value;
    }
  }
  return result;
}
