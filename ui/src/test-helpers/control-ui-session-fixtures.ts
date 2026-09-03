export type ControlUiSessionFixture = {
  key: string;
  sessionId?: string;
  updatedAt?: number;
  contextTokens?: number | null;
  kind?: string;
  pinned?: boolean;
  pinnedAt?: number;
  archived?: boolean;
  archivedAt?: number;
  [field: string]: unknown;
};

// Also serialized into the page realm; keep these builders free of module captures.
export function createControlUiSessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options?: Partial<ControlUiSessionFixture>,
) {
  const archivedAt = options?.archivedAt ?? (options?.archived ? updatedAt : undefined);
  const pinnedAt =
    archivedAt === undefined
      ? (options?.pinnedAt ?? (options?.pinned ? updatedAt : undefined))
      : undefined;
  return {
    displayName: label,
    hasActiveRun: false,
    key,
    sessionId: `session:${key}`,
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
    ...options,
    contextTokens: options?.contextTokens ?? null,
    kind: options?.kind ?? "direct",
    pinned: pinnedAt !== undefined,
    pinnedAt,
    archived: archivedAt !== undefined,
    archivedAt,
  };
}

export function createControlUiSessionFixtures(input: {
  rows: ControlUiSessionFixture[];
  mainKey: string;
}) {
  const records = new Map<string, { row: ControlUiSessionFixture; changed: Set<string> }>();
  const listed = new Set<string>();
  const materialized = new Set<string>();
  let materializedSequence = 0;
  let timestamp = 1_800_000_000_000;
  const canonicalKey = (key: string) => (key === "main" ? input.mainKey : key);
  const record = (inputKey: string) => {
    const key = canonicalKey(inputKey);
    let value = records.get(key);
    if (!value) {
      value = {
        // Unseeded case/sequence rows have identity, but no known metadata.
        row: { key, sessionId: `session:${key}` },
        changed: new Set(),
      };
      records.set(key, value);
    }
    return value;
  };
  for (const fixture of input.rows) {
    const key = canonicalKey(fixture.key);
    const archivedAt =
      fixture.archivedAt ?? (fixture.archived ? (fixture.updatedAt ?? ++timestamp) : undefined);
    const pinnedAt =
      archivedAt === undefined
        ? (fixture.pinnedAt ?? (fixture.pinned ? (fixture.updatedAt ?? ++timestamp) : undefined))
        : undefined;
    records.set(key, {
      row: {
        sessionId: `session:${key}`,
        ...fixture,
        key,
        archivedAt,
        archived: archivedAt !== undefined,
        pinnedAt,
        pinned: pinnedAt !== undefined,
      },
      changed: new Set(),
    });
    listed.add(key);
  }
  const read = (key: string) => ({ ...record(key).row });
  const patch = (key: string, fields: Record<string, unknown>) => {
    const value = record(key);
    const next = { ...value.row };
    // Validate before touching the owner: rejected or deferred writes must not leak.
    const archived = fields.archived ?? next.archived;
    if (archived && fields.pinned === true) {
      return {
        __mockError: {
          code: "INVALID_REQUEST",
          message: "cannot pin an archived session; restore it first",
        },
      };
    }
    const changed = new Set<string>();
    const set = (field: string, fieldValue: unknown) => {
      next[field] = fieldValue;
      changed.add(field);
    };
    for (const field of [
      "model",
      "thinkingLevel",
      "fastMode",
      "permissionMode",
      "label",
      "category",
      "icon",
      "color",
      "boardFace",
      "unread",
      "toolOverrides",
    ]) {
      if (Object.hasOwn(fields, field)) {
        set(field, fields[field]);
      }
    }
    if (Object.hasOwn(fields, "model")) {
      set("modelOverrideSource", fields.model == null ? null : "user");
    }
    if (Object.hasOwn(fields, "unread")) {
      if (fields.unread === true) {
        set("markedUnreadAt", ++timestamp);
      } else {
        set("lastReadAt", ++timestamp);
        set("markedUnreadAt", undefined);
      }
    }
    if (Object.hasOwn(fields, "archived")) {
      set("archivedAt", fields.archived ? (next.archivedAt ?? ++timestamp) : undefined);
      set("archived", next.archivedAt !== undefined);
      if (!fields.archived) {
        set("archivedBy", undefined);
      }
    }
    if (fields.archived === true || Object.hasOwn(fields, "pinned")) {
      set(
        "pinnedAt",
        fields.archived !== true && fields.pinned ? (next.pinnedAt ?? ++timestamp) : undefined,
      );
      set("pinned", next.pinnedAt !== undefined);
    }
    value.row = next;
    for (const field of changed) {
      value.changed.add(field);
    }
    return { ok: true, key: next.key, entry: read(key) };
  };
  const materialize = (key: string, fields: Partial<ControlUiSessionFixture>) => {
    const value = record(key);
    value.row = { ...value.row, ...fields, key: canonicalKey(key) };
    listed.add(canonicalKey(key));
    materialized.add(canonicalKey(key));
    materializedSequence += 1;
  };
  const list = (wireRows?: unknown[]) => {
    const rows = wireRows ?? [...listed].map(read);
    const keys = new Set(
      rows.flatMap((row) =>
        row && typeof row === "object" && "key" in row && typeof row.key === "string"
          ? [canonicalKey(row.key)]
          : [],
      ),
    );
    return [
      ...rows.map((row) => {
        if (!row || typeof row !== "object" || !("key" in row) || typeof row.key !== "string") {
          return row;
        }
        const value = record(row.key);
        // Wire rows may deliberately carry stale IDs. Fill ordinary defaults,
        // then replay only committed fields; never learn canonical state from a read.
        const result: Record<string, unknown> = Object.assign({}, value.row, row);
        for (const field of value.changed) {
          result[field] = value.row[field];
        }
        return result;
      }),
      ...[...materialized].filter((key) => !keys.has(key)).map(read),
    ];
  };
  return {
    read,
    // History publishes a full row replacement. An unseeded wire-only fixture
    // has no canonical metadata to publish until its caller declares the row.
    sessionInfo: (key: string) => (listed.has(canonicalKey(key)) ? read(key) : undefined),
    patch,
    materialize,
    list,
    materializedCount: () => materializedSequence,
    replaceCanonicalList(rows: unknown[]) {
      const replacements: ControlUiSessionFixture[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || !("key" in row) || typeof row.key !== "string") {
          throw new Error("Canonical sessions.list rows require a string key");
        }
        replacements.push({ ...row, key: canonicalKey(row.key) });
      }
      records.clear();
      listed.clear();
      materialized.clear();
      for (const fixture of replacements) {
        records.set(fixture.key, { row: fixture, changed: new Set() });
        listed.add(fixture.key);
      }
    },
  };
}
