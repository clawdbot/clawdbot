import type {
  ChannelIngressAdapter,
  ChannelIngressAdapterEntry,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  ChannelIngressSubject,
  StableChannelIngressIdentityParams,
} from "./runtime-types.js";
import type { InternalMatchMaterial } from "./types.js";

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
}): ChannelIngressAdapterEntry {
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
    dangerous: fieldDangerous(params.field, params.entry),
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
              field: fields[0],
              fieldIndex: 0,
              entry,
              entryIndex,
              value: "*",
              fallbackSuffix: "wildcard",
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
      const subjectKeys = new Set(
        subject.identifiers.flatMap((identifier) => {
          const field = fields.find((candidate) => candidate.kind === identifier.kind);
          if (!field) {
            return [];
          }
          const value = normalizeFieldValue(field, identifier.value, "subject");
          return value ? [identityMatchKey({ kind: identifier.kind, value })] : [];
        }),
      );
      const matchedEntryIds = entries
        .filter((entry) => {
          const fallback = entry.value === "*" || subjectKeys.has(identityMatchKey(entry));
          return identity.matchEntry?.({ subject, entry, context }) ?? fallback;
        })
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function createIdentitySubject(
  identity: ChannelIngressIdentityDescriptor,
  input: ChannelIngressIdentitySubjectInput,
): ChannelIngressSubject {
  const fields = identityFields(identity);
  const identifiers: InternalMatchMaterial[] = fields.flatMap((field, index) => {
    const rawValue = index === 0 ? input.stableId : input.aliases?.[field.key];
    if (rawValue == null) {
      return [];
    }
    const value = String(rawValue);
    return [
      {
        opaqueId: field.key,
        kind: field.kind,
        value,
        dangerous: fieldDangerous(field, value),
        sensitivity: field.sensitivity,
      },
    ];
  });
  return { identifiers };
}
