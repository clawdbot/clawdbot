import {
  asNullableRecord as asConfigRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { coerceConfigFormNumberString } from "../../components/config-form.numeric.ts";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { t } from "../../i18n/index.ts";
import {
  cloneConfigObject,
  removePathValue,
  sanitizeRedactedFormForSubmit,
  serializeConfigForm,
  setPathValue,
} from "../config-form-utils.ts";
import { parseJson5Text, warmJson5 } from "../json5-runtime.ts";
import {
  resolveAgentConfigEntryTarget,
  resolveEditableSnapshotConfig,
  type LoadConfigOptions,
  type RuntimeConfigState,
} from "./config-state-model.ts";

const autoAllowlistedPluginIdsByState = new WeakMap<RuntimeConfigState, Set<string>>();

export function clearConfigDraftTracking(state: RuntimeConfigState): void {
  autoAllowlistedPluginIdsByState.delete(state);
}

export function formatConfigMutationError(error: unknown, submittedRaw: string | null): string {
  let message = String(error);
  if (!submittedRaw || !(error instanceof GatewayRequestError) || !isRecord(error.details)) {
    return message;
  }
  const issues = error.details.issues;
  if (!Array.isArray(issues)) {
    return message;
  }
  const summaryPrefix = `${error.name}: invalid config: `;
  if (!message.startsWith(summaryPrefix)) {
    return message;
  }
  const submittedForm = parseConfigRawDraft(submittedRaw);
  if (!submittedForm) {
    return message;
  }
  let offset = summaryPrefix.length;
  for (const issue of issues) {
    if (
      !isRecord(issue) ||
      typeof issue.path !== "string" ||
      typeof issue.message !== "string" ||
      !message.startsWith(`${issue.path}: ${issue.message}`, offset)
    ) {
      break;
    }
    const displayPath = formatConfigIssuePathFromDraft(issue.path, submittedForm);
    if (displayPath !== issue.path) {
      message = `${message.slice(0, offset)}${displayPath}${message.slice(offset + issue.path.length)}`;
    }
    offset += displayPath.length + 2 + issue.message.length;
    if (!message.startsWith("; ", offset)) {
      break;
    }
    offset += 2;
  }
  return message;
}

function formatConfigIssuePathFromDraft(path: string, draft: unknown): string {
  const segments = path.split(".");

  const visit = (value: unknown, offset: number): string[] => {
    if (offset === segments.length) {
      return [""];
    }
    const segment = segments[offset];
    if (segment === undefined) {
      return [];
    }
    if (Array.isArray(value)) {
      const index = Number(segment);
      if (!/^\d+$/u.test(segment) || !Number.isSafeInteger(index) || !Object.hasOwn(value, index)) {
        return [segments.slice(offset).join(".")];
      }
      return visit(value[index], offset + 1).map((tail) =>
        tail ? `#${index + 1}.${tail}` : `#${index + 1}`,
      );
    }
    if (!isRecord(value)) {
      return [segments.slice(offset).join(".")];
    }

    const matches = Object.keys(value).flatMap((key) => {
      const keySegments = key.split(".");
      if (
        keySegments.length > segments.length - offset ||
        !keySegments.every((keySegment, index) => keySegment === segments[offset + index])
      ) {
        return [];
      }
      return visit(value[key], offset + keySegments.length).map((tail) =>
        tail ? `${key}.${tail}` : key,
      );
    });
    return matches.length > 0 ? matches : [segments.slice(offset).join(".")];
  };

  // Flattened Gateway paths cannot distinguish overlapping dotted object keys;
  // keep the machine path unless the actual draft proves one display spelling.
  const displayPaths = new Set(visit(draft, 0));
  return displayPaths.size === 1 ? (displayPaths.values().next().value ?? path) : path;
}

export function applyConfigSnapshot(
  state: RuntimeConfigState,
  snapshot: ConfigSnapshot,
  options: LoadConfigOptions = {},
) {
  const preservePendingChanges = state.configFormDirty && options.discardPendingChanges !== true;
  if (options.discardPendingChanges === true) {
    // Discard resets pending edits and stale save status, but NOT the restart
    // banner: a saved-but-unapplied config still needs an apply even after
    // the local draft is thrown away.
    state.configAutoSaveStatus = "idle";
  }
  const currentRevisionHash = snapshot.configRevisionHash ?? snapshot.hash ?? null;
  if (snapshot.appliedConfigHash !== undefined) {
    state.configNeedsApply = currentRevisionHash !== snapshot.appliedConfigHash;
  }
  const draftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  state.configSnapshot = snapshot;
  const editableConfig = resolveEditableSnapshotConfig(snapshot);
  const rawAvailable =
    typeof snapshot.raw === "string" || Boolean(editableConfig) || Boolean(state.configForm);
  if (!rawAvailable && state.configFormMode === "raw") {
    state.configFormMode = "form";
  }
  const rawFromSnapshot: string =
    typeof snapshot.raw === "string"
      ? snapshot.raw
      : editableConfig
        ? serializeConfigForm(editableConfig)
        : state.configRaw;
  if (!preservePendingChanges) {
    state.configRaw = rawFromSnapshot;
  } else if (state.configFormMode !== "raw" && state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else if (state.configFormMode !== "raw") {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  if (!preservePendingChanges) {
    state.configForm = cloneConfigObject(editableConfig ?? {});
    state.configFormOriginal = cloneConfigObject(editableConfig ?? {});
    setConfigRawOriginal(state, rawFromSnapshot);
    state.configFormDirty = false;
    state.configFormMode = "form";
    state.configDraftBaseHash = snapshot.hash ?? null;
    autoAllowlistedPluginIdsByState.delete(state);
  } else {
    state.configDraftBaseHash = draftBaseHash;
  }
}

function coerceBooleanString(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return value;
}

function coerceFormValues(value: unknown, schema: JsonSchema): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (schema.allOf && schema.allOf.length > 0) {
    const { allOf, ...baseSchema } = schema;
    let next: unknown = coerceFormValues(value, baseSchema);
    for (const segment of allOf) {
      next = coerceFormValues(next, segment);
    }
    return next;
  }

  const type = schemaType(schema);
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf ?? []).filter(
      (variant) =>
        !(
          variant.type === "null" ||
          (Array.isArray(variant.type) && variant.type.includes("null"))
        ),
    );

    if (variants.length === 1) {
      const variant = variants[0];
      return variant ? coerceFormValues(value, variant) : value;
    }
    if (typeof value === "string") {
      for (const variant of variants) {
        const variantType = schemaType(variant);
        if (variantType === "number" || variantType === "integer") {
          const coerced = coerceConfigFormNumberString(value, variantType === "integer");
          if (coerced === undefined || typeof coerced === "number") {
            return coerced;
          }
        }
        if (variantType === "boolean") {
          const coerced = coerceBooleanString(value);
          if (typeof coerced === "boolean") {
            return coerced;
          }
        }
      }
    }
    for (const variant of variants) {
      const variantType = schemaType(variant);
      if (variantType === "object" && typeof value === "object" && !Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
      if (variantType === "array" && Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
    }
    return value;
  }

  if (type === "number" || type === "integer") {
    if (typeof value === "string") {
      const coerced = coerceConfigFormNumberString(value, type === "integer");
      if (coerced === undefined || typeof coerced === "number") {
        return coerced;
      }
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "string") {
      const coerced = coerceBooleanString(value);
      if (typeof coerced === "boolean") {
        return coerced;
      }
    }
    return value;
  }
  if (type === "string") {
    return typeof value === "string" && value.length === 0 && schema.minLength ? undefined : value;
  }
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const props = schema.properties ?? {};
    const additional =
      schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : null;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props[key] ?? additional;
      const coerced = propSchema ? coerceFormValues(val, propSchema) : val;
      if (coerced !== undefined) {
        result[key] = coerced;
      }
    }
    return result;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      return value;
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      return value.map((item, index) => {
        const itemSchema = index < items.length ? items[index] : undefined;
        return itemSchema ? coerceFormValues(item, itemSchema) : item;
      });
    }
    return items
      ? value.map((item) => coerceFormValues(item, items)).filter((item) => item !== undefined)
      : value;
  }
  return value;
}

/**
 * Serialize the form state for submission to `config.set` / `config.apply`.
 *
 * HTML `<input>` elements produce string `.value` properties, so numeric and
 * boolean config fields can leak into `configForm` as strings.  We coerce
 * them back to their schema-defined types before JSON serialization so the
 * gateway's Zod validation always sees correctly typed values.
 */
export function serializeFormForSubmit(state: RuntimeConfigState): string {
  // A clean snapshot submits its raw bytes verbatim: reserializing the parsed
  // form would destroy JSON5 comments/formatting the file already has (the
  // restart banner's apply right after a raw-mode save hits exactly this).
  if (!state.configFormDirty && typeof state.configSnapshot?.raw === "string") {
    return state.configSnapshot.raw;
  }
  if (state.configFormMode !== "form" || !state.configForm) {
    return state.configRaw;
  }
  const schema = isRecord(state.configSchema) ? (state.configSchema as JsonSchema) : null;
  const form = schema
    ? (coerceFormValues(state.configForm, schema) as Record<string, unknown>)
    : state.configForm;
  const sanitized = sanitizeRedactedFormForSubmit(
    form,
    state.configFormOriginal,
    state.configRawOriginalParsed,
  );
  return serializeConfigForm(sanitized);
}

/**
 * Adopts a successful write ack as the authoritative local snapshot BEFORE
 * any reload: the submitted bytes are on disk under the acked hash, so the
 * raw/hash/originals must never keep describing the pre-save file (a failed
 * best-effort reload would otherwise leave stale-bytes paths alive — e.g.
 * apply re-submitting the old raw, or a revert-during-reload comparing
 * clean). Server-resolved values (secret redaction) still refresh via the
 * follow-up reload, which is purely cosmetic from here on.
 */
export function adoptConfigSetAck(
  state: RuntimeConfigState,
  submittedRaw: string,
  ackHash: string | null,
) {
  const parsed = parseConfigRawDraft(submittedRaw);
  state.configSnapshot = {
    ...state.configSnapshot,
    raw: submittedRaw,
    hash: ackHash ?? state.configSnapshot?.hash ?? null,
    valid: true,
    issues: [],
    ...(parsed ? { config: parsed, sourceConfig: parsed } : {}),
  };
  state.configValid = true;
  state.configIssues = [];
  setConfigRawOriginal(state, submittedRaw);
  if (parsed) {
    state.configFormOriginal = cloneConfigObject(parsed);
  }
  state.configDraftBaseHash = ackHash;
  if (!state.configFormDirty) {
    // Clean drafts snap to the persisted bytes, mirroring what a reload's
    // non-preserving snapshot application would do.
    state.configRaw = submittedRaw;
    if (parsed) {
      state.configForm = cloneConfigObject(parsed);
    }
  }
}

// Legacy hashless ack: when the follow-up reload returns exactly the submitted
// bytes, rebase a preserved dirty draft onto that authoritative hash. Foreign
// content matches neither and stays fail-closed.
export function reconcileHashlessWriteReload(state: RuntimeConfigState, submittedRaw: string) {
  if (state.configSnapshot?.raw !== submittedRaw) {
    return;
  }
  const hash = state.configSnapshot.hash ?? null;
  if (state.configFormDirty) {
    state.configDraftBaseHash = hash ?? state.configDraftBaseHash;
  }
}

function syncConfigDraft(state: RuntimeConfigState, nextForm: Record<string, unknown>) {
  const original = cloneConfigObject(
    state.configFormOriginal ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
  );
  const nextRaw = serializeConfigForm(nextForm);
  const originalRaw = serializeConfigForm(original);
  state.configForm = nextForm;
  state.configRaw = nextRaw;
  state.configFormDirty = nextRaw !== originalRaw;
  // configFormMode tracks which draft is authoritative for submission; a form
  // edit supersedes any earlier raw-text draft.
  state.configFormMode = "form";
  resetStaleAutoSaveStatus(state);
}

/**
 * Any mutation invalidates a lingering "Saved"/"Save failed" indicator: a
 * dirty edit is about to reschedule, and a clean revert makes the old
 * failure moot (its error is cleared too). Three states persist regardless:
 * "saving" reports the in-flight request, "conflict" marks the snapshot
 * itself stale, and "paused" marks the reconnect latch — only an explicit
 * Save/Apply or discard clears it, no local edit can.
 */
function resetStaleAutoSaveStatus(state: RuntimeConfigState) {
  if (
    state.configAutoSaveStatus === "saving" ||
    state.configAutoSaveStatus === "conflict" ||
    state.configAutoSaveStatus === "paused"
  ) {
    return;
  }
  if (!state.configFormDirty && state.configAutoSaveStatus === "error") {
    state.lastError = null;
  }
  state.configAutoSaveStatus = "idle";
}

function parseConfigRawDraft(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseJson5Text(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Parse the authoritative raw once at ingestion so submit-time sanitizing
// stays synchronous and never races the lazy JSON5 parser. Submit paths await
// configRawOriginalParsePending so a JSON5 config racing the first parser load
// cannot bypass redaction sanitizing.
function setConfigRawOriginal(state: RuntimeConfigState, raw: string) {
  state.configRawOriginal = raw;
  state.configRawOriginalParsePending = null;
  try {
    state.configRawOriginalParsed = asConfigRecord(parseJson5Text(raw));
    return;
  } catch {
    state.configRawOriginalParsed = null;
  }
  const pending = warmJson5()
    .then((json5) => {
      if (state.configRawOriginal !== raw || state.configRawOriginalParsePending !== pending) {
        return;
      }
      try {
        state.configRawOriginalParsed = asConfigRecord(json5.parse(raw));
      } catch {
        state.configRawOriginalParsed = null;
      }
    })
    // Never-rejecting and self-clearing: submit gates await this promise, and
    // a failed chunk load must not wedge every later save of this state.
    .catch(() => undefined)
    .finally(() => {
      if (state.configRawOriginalParsePending === pending) {
        state.configRawOriginalParsePending = null;
      }
    });
  state.configRawOriginalParsePending = pending;
}

function mutateConfigForm(
  state: RuntimeConfigState,
  mutate: (draft: Record<string, unknown>) => void,
) {
  let base: Record<string, unknown>;
  if (state.configFormDirty && state.configFormMode === "raw") {
    // A dirty raw draft is authoritative. Form patches (Quick Settings shares
    // this capability) may only apply on top of its parsed content — building
    // on the stale parsed form would silently destroy the raw edits.
    // Contract: merging onto the parsed raw draft is intentional — content is
    // preserved, but the unsaved raw draft's formatting/comments are not once
    // form editing resumes.
    const parsedRawDraft = parseConfigRawDraft(state.configRaw);
    if (!parsedRawDraft) {
      // Unparseable raw draft: refuse the form edit and tell the user to
      // resolve the raw buffer first; the raw draft stays authoritative.
      state.configAutoSaveStatus = "error";
      state.lastError = t("configView.rawDraftBlocksFormEdit");
      return;
    }
    base = parsedRawDraft;
  } else {
    base = cloneConfigObject(
      state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
    );
  }
  mutate(base);
  syncConfigDraft(state, base);
}

function trackAutoAllowlistedPluginId(state: RuntimeConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (pluginIds) {
    pluginIds.add(pluginId);
  } else {
    autoAllowlistedPluginIdsByState.set(state, new Set([pluginId]));
  }
}

function untrackAutoAllowlistedPluginId(state: RuntimeConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!pluginIds) {
    return;
  }
  pluginIds.delete(pluginId);
  if (pluginIds.size === 0) {
    autoAllowlistedPluginIdsByState.delete(state);
  }
}

function syncEnabledPluginAllowlist(
  state: RuntimeConfigState,
  draft: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
) {
  if (
    path.length !== 4 ||
    path[0] !== "plugins" ||
    path[1] !== "entries" ||
    typeof path[2] !== "string" ||
    path[3] !== "enabled"
  ) {
    return;
  }
  const pluginId = path[2];
  const plugins =
    draft.plugins && typeof draft.plugins === "object" && !Array.isArray(draft.plugins)
      ? (draft.plugins as Record<string, unknown>)
      : null;
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : null;
  if (!allow) {
    untrackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  if (value === true) {
    if (allow.includes(pluginId)) {
      return;
    }
    if (allow.length === 0) {
      untrackAutoAllowlistedPluginId(state, pluginId);
      return;
    }
    setPathValue(draft, ["plugins", "allow"], [...allow, pluginId]);
    trackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  const autoAllowlistedPluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!autoAllowlistedPluginIds?.has(pluginId)) {
    return;
  }
  setPathValue(
    draft,
    ["plugins", "allow"],
    allow.filter((entry) => entry !== pluginId),
  );
  untrackAutoAllowlistedPluginId(state, pluginId);
}

export function updateConfigFormValue(
  state: RuntimeConfigState,
  path: Array<string | number>,
  value: unknown,
) {
  mutateConfigForm(state, (draft) => {
    setPathValue(draft, path, value);
    if (path[0] === "plugins" && path[1] === "allow") {
      autoAllowlistedPluginIdsByState.delete(state);
      return;
    }
    syncEnabledPluginAllowlist(state, draft, path, value);
  });
}

export function updateConfigRawValue(state: RuntimeConfigState, value: string) {
  // Raw drafts may carry JSON5 comments; warm the parser before any
  // mutateConfigForm/diff path needs it synchronously.
  void warmJson5().catch(() => undefined);
  state.configRaw = value;
  // A raw-text edit becomes the authoritative draft; without this,
  // serializeFormForSubmit would submit the stale form and drop raw edits.
  state.configFormMode = "raw";
  state.configFormDirty = value !== state.configRawOriginal;
  resetStaleAutoSaveStatus(state);
  if (state.configFormDirty) {
    state.configDraftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  } else {
    state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  }
}

export function resetConfigPendingChanges(state: RuntimeConfigState) {
  const editableConfig = resolveEditableSnapshotConfig(state.configSnapshot);
  state.configForm = cloneConfigObject(state.configFormOriginal ?? editableConfig ?? {});
  state.configRaw =
    state.configRawOriginal ??
    serializeConfigForm(state.configFormOriginal ?? editableConfig ?? {});
  state.configFormDirty = false;
  state.configFormMode = "form";
  state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  autoAllowlistedPluginIdsByState.delete(state);
}

export function removeConfigFormValue(state: RuntimeConfigState, path: Array<string | number>) {
  mutateConfigForm(state, (draft) => removePathValue(draft, path));
}

export function stageDefaultAgentConfigEntry(state: RuntimeConfigState, agentId: string): boolean {
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const target = resolveAgentConfigEntryTarget(source, agentId);
  if (!target) {
    return false;
  }
  const authoredAgentId = target.path[2];
  mutateConfigForm(state, (draft) => {
    const agents = isRecord(draft.agents) ? draft.agents : null;
    const entries = isRecord(agents?.entries) ? agents.entries : null;
    if (!entries) {
      return;
    }
    for (const [id, entry] of Object.entries(entries)) {
      if (!isRecord(entry)) {
        continue;
      }
      if (id === authoredAgentId) {
        entry.default = true;
      } else {
        delete entry.default;
      }
    }
  });
  return true;
}
