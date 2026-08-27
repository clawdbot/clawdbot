import { expectDefined } from "@openclaw/normalization-core";
import type { IdentifierAuthentication } from "./identifier-authentication.js";
/**
 * Channel ingress identity adapter helpers.
 *
 * Builds stable sender identity descriptors and normalizes matchable allowlist material.
 */
import type {
  ChannelIngressAdapter,
  ChannelIngressAdapterEntry,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  StableChannelIngressIdentityParams,
} from "./runtime-types.js";
import type { NormalizedIngressEntry, NormalizedIngressSubject } from "./types.js";

type ResolvedIdentityField = Required<Pick<ChannelIngressIdentityField, "key" | "kind">> &
  Omit<ChannelIngressIdentityField, "key" | "kind">;

/** Build an identity descriptor for channels with one stable id and optional aliases. */
export function defineStableChannelIngressIdentity(
  params: StableChannelIngressIdentityParams = {},
): ChannelIngressIdentityDescriptor {
  const { entryIdPrefix, resolveEntryId, aliases, isWildcardEntry, matchEntry, ...primary } =
    params;
  return {
    primary,
    aliases,
    isWildcardEntry,
    matchEntry,
    resolveEntryId:
      resolveEntryId ??
      (entryIdPrefix ? ({ entryIndex }) => `${entryIdPrefix}-${entryIndex + 1}` : undefined),
  };
}

function defaultNormalize(value: string): string {
  return value;
}

function normalizeFieldValue(
  field: ResolvedIdentityField,
  value: string,
  mode: "entry" | "subject",
): string | null {
  const normalize =
    mode === "entry"
      ? (field.normalizeEntry ?? field.normalize ?? defaultNormalize)
      : (field.normalizeSubject ?? field.normalize ?? defaultNormalize);
  const normalized = normalize(value);
  return normalized == null ? null : normalized.trim() || null;
}

function fieldDangerous(field: ResolvedIdentityField, value: string): boolean | undefined {
  return typeof field.dangerous === "function" ? field.dangerous(value) : field.dangerous;
}

function fieldAuthentication(
  field: ResolvedIdentityField,
  value: string,
): IdentifierAuthentication | undefined {
  return typeof field.authentication === "function"
    ? field.authentication(value)
    : field.authentication;
}

function identityFields(identity: ChannelIngressIdentityDescriptor): ResolvedIdentityField[] {
  const fields: ResolvedIdentityField[] = [
    {
      ...identity.primary,
      key: identity.primary.key ?? "stableId",
      kind: identity.primary.kind ?? "stable-id",
    },
  ];
  for (const alias of identity.aliases ?? []) {
    fields.push({
      ...alias,
      kind: alias.kind ?? (`plugin:${alias.key}` as const),
    });
  }
  return fields;
}

function identityMatchKey(entry: Pick<ChannelIngressAdapterEntry, "kind" | "value">): string {
  return `${entry.kind}:${entry.value}`;
}

function adapterEntry(params: {
  identity: ChannelIngressIdentityDescriptor;
  field: ResolvedIdentityField;
  fieldIndex: number;
  entry: string;
  entryIndex: number;
  value: string;
  fallbackSuffix?: string;
  wildcard?: boolean;
}): NormalizedIngressEntry {
  const dangerous = fieldDangerous(params.field, params.entry);
  return {
    opaqueEntryId:
      params.identity.resolveEntryId?.({
        entry: params.entry,
        entryIndex: params.entryIndex,
        fieldKey: params.field.key,
        fieldIndex: params.fieldIndex,
      }) ?? `entry-${params.entryIndex + 1}:${params.fallbackSuffix ?? params.field.key}`,
    kind: params.field.kind,
    value: params.value,
    identityFieldKey: params.field.key,
    ...(params.wildcard ? { wildcard: true } : {}),
    authentication:
      fieldAuthentication(params.field, params.entry) ?? (dangerous ? "mutable" : "asserted"),
    dangerous,
    sensitivity: params.field.sensitivity,
  };
}

export function createIdentityAdapter(
  identity: ChannelIngressIdentityDescriptor,
): ChannelIngressAdapter {
  const fields = identityFields(identity);
  const isWildcardEntry = identity.isWildcardEntry ?? ((value: string) => value === "*");
  return {
    normalizeEntries({ entries }) {
      const matchable = entries.flatMap((entry, entryIndex) => {
        if (isWildcardEntry(entry)) {
          return [
            adapterEntry({
              identity,
              field: expectDefined(fields[0], "fields entry at 0"),
              fieldIndex: 0,
              entry,
              entryIndex,
              value: "*",
              fallbackSuffix: "wildcard",
              wildcard: true,
            }),
          ];
        }
        return fields.flatMap((field, fieldIndex) => {
          const value = normalizeFieldValue(field, entry, "entry");
          if (!value) {
            return [];
          }
          return [adapterEntry({ identity, field, fieldIndex, entry, entryIndex, value })];
        });
      });
      return {
        matchable,
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries, context }) {
      const normalizedSubjects = subject.identifiers.flatMap((identifier) => {
        const field = fields.find(
          (candidate) =>
            candidate.key === identifier.opaqueId && candidate.kind === identifier.kind,
        );
        if (!field) {
          return [];
        }
        const value = normalizeFieldValue(field, identifier.value, "subject");
        return value ? [{ identifier, value }] : [];
      });
      const matchedPairs = entries.flatMap((entry) => {
        const legacyMatch = identity.matchEntry?.({ subject, entry, context });
        if (legacyMatch === false) {
          return [];
        }
        const candidates = entry.wildcard
          ? normalizedSubjects.filter(({ identifier }) => identifier.kind === fields[0]?.kind)
          : normalizedSubjects.filter(
              ({ identifier, value }) =>
                identifier.opaqueId === entry.identityFieldKey &&
                identifier.kind === entry.kind &&
                identityMatchKey({ kind: identifier.kind, value }) === identityMatchKey(entry),
            );
        if (candidates.length === 0) {
          // A legacy positive whole-subject matcher has no exact subject provenance. Preserve
          // its shipped asserted behavior, but never reinterpret it as a stronger claim.
          return legacyMatch === true
            ? [
                {
                  opaqueEntryId: entry.opaqueEntryId,
                  opaqueSubjectId: "legacy-subject-match",
                  subjectAuthentication: "asserted" as const,
                },
              ]
            : entry.wildcard
              ? [
                  {
                    opaqueEntryId: entry.opaqueEntryId,
                    opaqueSubjectId: "wildcard-subject",
                    subjectAuthentication: "asserted" as const,
                  },
                ]
              : [];
        }
        return candidates.map(({ identifier }) => ({
          opaqueEntryId: entry.opaqueEntryId,
          opaqueSubjectId: identifier.opaqueId,
          subjectAuthentication: identifier.authentication,
        }));
      });
      const matchedEntryIds = [...new Set(matchedPairs.map((pair) => pair.opaqueEntryId))];
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
        matchedPairs,
      };
    },
  };
}

export function createIdentitySubject(
  identity: ChannelIngressIdentityDescriptor,
  input: ChannelIngressIdentitySubjectInput,
): NormalizedIngressSubject {
  const fields = identityFields(identity);
  const identifiers: NormalizedIngressSubject["identifiers"] = fields.flatMap((field, index) => {
    const rawValue = index === 0 ? input.stableId : input.aliases?.[field.key];
    if (rawValue == null) {
      return [];
    }
    const value = String(rawValue);
    const dangerous = fieldDangerous(field, value);
    // A supplied map owns every per-message claim; omitted fields must not inherit
    // a stronger static declaration from the identity descriptor.
    const authentication =
      input.authentication !== undefined
        ? (input.authentication[field.key] ?? "unverified")
        : (fieldAuthentication(field, value) ?? (dangerous ? "mutable" : "asserted"));
    return [
      {
        opaqueId: field.key,
        kind: field.kind,
        value,
        authentication,
        dangerous,
        sensitivity: field.sensitivity,
      },
    ];
  });
  return { identifiers };
}
