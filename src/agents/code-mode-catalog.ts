import { createHash } from "node:crypto";
import { tokTypes } from "acorn";
import type { CatalogSource } from "./tool-search-types.js";

type CompactCatalogEntry = {
  id: string;
  source: CatalogSource;
  name: string;
  label?: string;
  description: string;
  input?: string;
  output?: string;
};

export type CodeModeCatalogBinding = Omit<CompactCatalogEntry, "id"> & {
  id: string;
  callableName: string;
};

const RESERVED_GLOBAL_NAMES = new Set(
  "ALL_TOOLS API MCP agents catalog clearTimeout globalThis json log namespaces nodes phase setTimeout skills text tools yield_control AggregateError Array ArrayBuffer Atomics BigInt BigInt64Array BigUint64Array Boolean DataView Date Error EvalError FinalizationRegistry Float32Array Float64Array Function Infinity Int16Array Int32Array Int8Array Intl JSON Map Math NaN Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer String Symbol SyntaxError TypeError URIError Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap WeakRef WeakSet WebAssembly console decodeURI decodeURIComponent encodeURI encodeURIComponent escape eval isFinite isNaN parseFloat parseInt undefined unescape".split(
    " ",
  ),
);

const RESERVED_WORDS = new Set([
  ...Object.values(tokTypes).flatMap((token) => (token.keyword ? [token.keyword] : [])),
  "await",
  "enum",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
]);

const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function normalizedCallableBase(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `tool_${normalized}`;
}

function suffixedCallableName(base: string, id: string, used: ReadonlySet<string>): string {
  const digest = createHash("sha256").update(id).digest("hex");
  for (let length = 8; length <= digest.length; length += 2) {
    const candidate = `${base}_${digest.slice(0, length)}`;
    if (!used.has(candidate) && !RESERVED_WORDS.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("could not allocate a unique code mode callable name");
}

function selectEffectiveEntries(entries: readonly CompactCatalogEntry[]): CompactCatalogEntry[] {
  const winners = new Map<string, CompactCatalogEntry>();
  for (const entry of entries) {
    if (entry.source === "mcp") {
      continue;
    }
    const current = winners.get(entry.name);
    if (!current || (entry.source === "client" && current.source !== "client")) {
      winners.set(entry.name, entry);
    }
  }
  return [...winners.values()];
}

/** Canonical host projection shared by the prompt, guest bindings, and bridge routing. */
export function createCodeModeCatalogProjection(
  entries: readonly CompactCatalogEntry[],
  options?: { reservedNames?: Iterable<string> },
) {
  const used = new Set([...RESERVED_GLOBAL_NAMES, ...(options?.reservedNames ?? [])]);
  const candidates = selectEffectiveEntries(entries)
    .map((entry) => {
      const base = normalizedCallableBase(entry.name);
      const canKeepExactName =
        JS_IDENTIFIER.test(entry.name) && !RESERVED_WORDS.has(entry.name) && !used.has(entry.name);
      return { entry, base, canKeepExactName };
    })
    .toSorted(
      (left, right) =>
        Number(right.canKeepExactName) - Number(left.canKeepExactName) ||
        left.base.localeCompare(right.base) ||
        left.entry.id.localeCompare(right.entry.id),
    );
  const bindings: CodeModeCatalogBinding[] = [];
  for (const candidate of candidates) {
    let callableName = candidate.base;
    if (RESERVED_WORDS.has(callableName) || used.has(callableName)) {
      callableName = suffixedCallableName(candidate.base, candidate.entry.id, used);
    }
    used.add(callableName);
    const { id, source, name, label, description, input, output } = candidate.entry;
    bindings.push({ id, source, name, label, description, input, output, callableName });
  }
  bindings.sort((left, right) => left.callableName.localeCompare(right.callableName));
  return {
    bindings,
    guestBindings: bindings.map(({ id: _id, ...binding }) => binding),
    byCallableName: new Map(bindings.map((binding) => [binding.callableName, binding])),
    byId: new Map(bindings.map((binding) => [binding.id, binding])),
  };
}

export type CodeModeCatalogProjection = ReturnType<typeof createCodeModeCatalogProjection>;

export function redactCodeModeCatalogIds(
  message: string,
  bindings: readonly CodeModeCatalogBinding[],
): string {
  let redacted = message;
  for (const binding of bindings.toSorted((left, right) => right.id.length - left.id.length)) {
    redacted = redacted.replaceAll(binding.id, binding.callableName);
  }
  return redacted;
}
