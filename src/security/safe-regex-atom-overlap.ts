import { expectDefined } from "@openclaw/normalization-core";

const MAX_ALTERNATIVES = 64;
const MAX_OVERLAP_PROBES = 4096;
const ASCII_ATOM_SAMPLES = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
const AUDITED_UNICODE_CASE_FOLD_VERSIONS = new Set(["15.1", "16.0", "17.0"]);
// Complete simple/common case-fold endpoints that cross Script boundaries in
// the Unicode data shipped by supported Node runtimes. Unknown Unicode versions
// fail closed until this set is re-audited.
const CROSS_SCRIPT_CASE_FOLD_SAMPLES = ["\u00b5", "\u0345", "\u03b9", "\u03bc"];

// ECMAScript general-category aliases form a small closed hierarchy. Keeping
// that hierarchy lets the overlap check prove common Unicode properties
// disjoint without enumerating every code point during config validation.
const GENERAL_CATEGORY_GROUPS = [
  [
    ["L", "Letter"],
    [
      ["Lu", "Uppercase_Letter"],
      ["Ll", "Lowercase_Letter"],
      ["Lt", "Titlecase_Letter"],
      ["Lm", "Modifier_Letter"],
      ["Lo", "Other_Letter"],
    ],
  ],
  [
    ["M", "Mark"],
    [
      ["Mn", "Nonspacing_Mark"],
      ["Mc", "Spacing_Mark"],
      ["Me", "Enclosing_Mark"],
    ],
  ],
  [
    ["N", "Number"],
    [
      ["Nd", "Decimal_Number"],
      ["Nl", "Letter_Number"],
      ["No", "Other_Number"],
    ],
  ],
  [
    ["P", "Punctuation"],
    [
      ["Pc", "Connector_Punctuation"],
      ["Pd", "Dash_Punctuation"],
      ["Ps", "Open_Punctuation"],
      ["Pe", "Close_Punctuation"],
      ["Pi", "Initial_Punctuation"],
      ["Pf", "Final_Punctuation"],
      ["Po", "Other_Punctuation"],
    ],
  ],
  [
    ["S", "Symbol"],
    [
      ["Sm", "Math_Symbol"],
      ["Sc", "Currency_Symbol"],
      ["Sk", "Modifier_Symbol"],
      ["So", "Other_Symbol"],
    ],
  ],
  [
    ["Z", "Separator"],
    [
      ["Zs", "Space_Separator"],
      ["Zl", "Line_Separator"],
      ["Zp", "Paragraph_Separator"],
    ],
  ],
  [
    ["C", "Other"],
    [
      ["Cc", "Control"],
      ["Cf", "Format"],
      ["Cs", "Surrogate"],
      ["Co", "Private_Use"],
      ["Cn", "Unassigned"],
    ],
  ],
] as const;

function normalizeUnicodePropertyName(value: string): string {
  return value.replace(/[_\s-]/g, "").toLowerCase();
}

const GENERAL_CATEGORY_MASKS = (() => {
  const masks = new Map<string, number>();
  let bitIndex = 0;
  for (const [groupAliases, members] of GENERAL_CATEGORY_GROUPS) {
    let groupMask = 0;
    for (const aliases of members) {
      const bit = 2 ** bitIndex;
      bitIndex += 1;
      groupMask |= bit;
      for (const alias of aliases) {
        masks.set(normalizeUnicodePropertyName(alias), bit);
      }
    }
    for (const alias of groupAliases) {
      masks.set(normalizeUnicodePropertyName(alias), groupMask);
    }
  }
  return masks;
})();

const ALL_GENERAL_CATEGORIES_MASK = 2 ** 30 - 1;

function parseUnicodePropertyAtom(
  source: string,
):
  | { kind: "category"; mask: number }
  | { kind: "binary"; name: string; negated: boolean }
  | { kind: "script"; name: string; negated: boolean; source: string }
  | null {
  const match = source.match(/^\\([pP])\{([^}]+)\}$/);
  if (!match) {
    return null;
  }
  const negated = match[1] === "P";
  const rawProperty = match[2] ?? "";
  const separator = rawProperty.indexOf("=");
  const propertyName =
    separator < 0 ? "" : normalizeUnicodePropertyName(rawProperty.slice(0, separator));
  const value = normalizeUnicodePropertyName(
    separator < 0 ? rawProperty : rawProperty.slice(separator + 1),
  );
  const categoryMask =
    separator < 0 || propertyName === "gc" || propertyName === "generalcategory"
      ? GENERAL_CATEGORY_MASKS.get(value)
      : undefined;
  if (categoryMask !== undefined) {
    return {
      kind: "category",
      mask: negated ? ALL_GENERAL_CATEGORIES_MASK ^ categoryMask : categoryMask,
    };
  }
  if (
    (propertyName === "sc" || propertyName === "script") &&
    // Unicode script aliases are four letters. Restrict disjointness proofs to
    // canonical long names so equivalent aliases still fail closed.
    value.length > 4
  ) {
    return { kind: "script", name: value, negated, source };
  }
  return separator < 0 ? { kind: "binary", name: value, negated } : null;
}

function scriptPropertiesAreDisjointUnderCaseFold(
  left: string,
  right: string,
  flags: string,
): boolean {
  const unicodeVersion = process.versions.unicode;
  if (!unicodeVersion || !AUDITED_UNICODE_CASE_FOLD_VERSIONS.has(unicodeVersion)) {
    return false;
  }
  try {
    const safeFlags = flags.replace(/[gy]/g, "");
    const leftRegex = new RegExp(`^(?:${left})$`, safeFlags);
    const rightRegex = new RegExp(`^(?:${right})$`, safeFlags);
    return !CROSS_SCRIPT_CASE_FOLD_SAMPLES.some(
      (sample) => leftRegex.test(sample) && rightRegex.test(sample),
    );
  } catch {
    return false;
  }
}

function unicodePropertiesAreProvablyDisjoint(left: string, right: string, flags: string): boolean {
  const leftProperty = parseUnicodePropertyAtom(left);
  const rightProperty = parseUnicodePropertyAtom(right);
  if (!leftProperty || !rightProperty) {
    return false;
  }
  if (leftProperty.kind === "category" && rightProperty.kind === "category") {
    let leftMask = leftProperty.mask;
    let rightMask = rightProperty.mask;
    if (flags.includes("i")) {
      // Unicode case folding can cross Letter/Mark subcategories, but it does
      // not turn letters into numbers, punctuation, separators, or controls.
      const foldSensitiveMask =
        (GENERAL_CATEGORY_MASKS.get("letter") ?? 0) | (GENERAL_CATEGORY_MASKS.get("mark") ?? 0);
      if ((leftMask & foldSensitiveMask) !== 0) {
        leftMask |= foldSensitiveMask;
      }
      if ((rightMask & foldSensitiveMask) !== 0) {
        rightMask |= foldSensitiveMask;
      }
    }
    return (leftMask & rightMask) === 0;
  }
  if (leftProperty.kind === "script" && rightProperty.kind === "script") {
    if (leftProperty.name === rightProperty.name) {
      return !flags.includes("i") && leftProperty.negated !== rightProperty.negated;
    }
    if (leftProperty.negated || rightProperty.negated) {
      return false;
    }
    return (
      !flags.includes("i") ||
      scriptPropertiesAreDisjointUnderCaseFold(leftProperty.source, rightProperty.source, flags)
    );
  }
  return (
    !flags.includes("i") &&
    leftProperty.kind === "binary" &&
    rightProperty.kind === "binary" &&
    leftProperty.name === rightProperty.name &&
    leftProperty.negated !== rightProperty.negated
  );
}

export function readLegacyOctalEscape(
  source: string,
  index: number,
): { value: string; next: number } | null {
  const first = source[index + 1];
  if (!first || !/^[0-7]$/.test(first)) {
    return null;
  }
  // Annex B permits three octal digits only when the first is 0-3;
  // otherwise the third digit is a separate pattern atom.
  const maxDigits = /^[0-3]$/.test(first) ? 3 : 2;
  let next = index + 2;
  while (
    next < source.length &&
    next < index + 1 + maxDigits &&
    /^[0-7]$/.test(source[next] ?? "")
  ) {
    next += 1;
  }
  const octal = source.slice(index + 1, next);
  return { value: String.fromCodePoint(Number.parseInt(octal, 8)), next };
}

export function readEscapedLiteral(
  source: string,
  index: number,
): { value: string; next: number } | null {
  const marker = source[index + 1];
  if (!marker) {
    return null;
  }
  if (marker === "x") {
    const hex = source.slice(index + 2, index + 4);
    return /^[\da-f]{2}$/i.test(hex)
      ? { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 4 }
      : null;
  }
  if (marker === "u") {
    if (source[index + 2] === "{") {
      const closing = source.indexOf("}", index + 3);
      if (closing < 0) {
        return null;
      }
      const hex = source.slice(index + 3, closing);
      const codePoint = /^[\da-f]+$/i.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? { value: String.fromCodePoint(codePoint), next: closing + 1 }
        : null;
    }
    const hex = source.slice(index + 2, index + 6);
    return /^[\da-f]{4}$/i.test(hex)
      ? { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 6 }
      : null;
  }
  if (marker === "c" && /^[a-z]$/i.test(source[index + 2] ?? "")) {
    return {
      value: String.fromCodePoint((source.charCodeAt(index + 2) || 0) % 32),
      next: index + 3,
    };
  }
  if (/^[0-7]$/.test(marker)) {
    return readLegacyOctalEscape(source, index);
  }
  if (/^[\\^$.*+?()[\]{}|/-]$/.test(marker)) {
    return { value: marker, next: index + 2 };
  }
  return null;
}

function finiteCharacterClassValues(source: string, flags: string): string[] | null {
  if (!source.startsWith("[") || !source.endsWith("]") || source.startsWith("[^")) {
    return null;
  }
  const unicodeAware = flags.includes("u") || flags.includes("v");
  const values = new Set<string>();
  const elements: Array<{ value: string; escaped: boolean }> = [];
  for (let index = 1; index < source.length - 1;) {
    if (source[index] === "\\") {
      const escaped = readEscapedLiteral(source, index);
      if (!escaped) {
        return null;
      }
      const escapedCodeUnit = escaped.value.charCodeAt(0);
      // In Unicode mode, adjacent escaped surrogates inside a class can form one code point.
      // Keep the overlap proof conservative instead of modeling either code unit independently.
      if (
        unicodeAware &&
        escaped.value.length === 1 &&
        escapedCodeUnit >= 0xd800 &&
        escapedCodeUnit <= 0xdfff
      ) {
        return null;
      }
      elements.push({ value: escaped.value, escaped: true });
      index = escaped.next;
      continue;
    }
    const value = unicodeAware
      ? String.fromCodePoint(expectDefined(source.codePointAt(index), "character class code point"))
      : source.charAt(index);
    elements.push({ value, escaped: false });
    index += value.length;
  }
  for (let index = 0; index < elements.length; index += 1) {
    const element = expectDefined(elements[index], "character class element");
    const hyphen = elements[index + 1];
    const rangeEnd = elements[index + 2];
    if (hyphen?.value === "-" && !hyphen.escaped && rangeEnd) {
      const startCodePoint = expectDefined(element.value.codePointAt(0), "range start");
      const endCodePoint = expectDefined(rangeEnd.value.codePointAt(0), "range end");
      if (endCodePoint < startCodePoint || endCodePoint - startCodePoint > 1024) {
        return null;
      }
      for (let codePoint = startCodePoint; codePoint <= endCodePoint; codePoint += 1) {
        values.add(String.fromCodePoint(codePoint));
      }
      index += 2;
    } else {
      values.add(element.value);
    }
    if (values.size > 2048) {
      return null;
    }
  }
  return [...values];
}

function finiteAtomValues(source: string, flags: string): string[] | null {
  const classValues = finiteCharacterClassValues(source, flags);
  if (classValues) {
    return classValues;
  }
  if (source === "\\d") {
    return Array.from({ length: 10 }, (_, index) => String(index));
  }
  if (source === "\\w") {
    return Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz0123456789");
  }
  if (source === "\\s") {
    return [
      "\t",
      "\n",
      "\v",
      "\f",
      "\r",
      " ",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];
  }
  if (source.startsWith("\\")) {
    const escaped = readEscapedLiteral(source, 0);
    return escaped?.next === source.length ? [escaped.value] : null;
  }
  const characters = Array.from(source);
  return characters.length === 1 && !/^[.^$*+?()[\]{}|]$/.test(source) ? characters : null;
}

function atomsMayOverlap(left: string, right: string, flags: string): boolean {
  if (left === right) {
    return true;
  }
  if (/^\\(?:[1-9]\d*|k<)/.test(left) || /^\\(?:[1-9]\d*|k<)/.test(right)) {
    // Backreferences only have meaning in the complete pattern's capture context.
    // A standalone atom probe cannot prove them disjoint from another branch.
    return true;
  }
  if (unicodePropertiesAreProvablyDisjoint(left, right, flags)) {
    return false;
  }
  try {
    const safeFlags = flags.replace(/[gy]/g, "");
    const leftRegex = new RegExp(`^(?:${left})$`, safeFlags);
    const rightRegex = new RegExp(`^(?:${right})$`, safeFlags);
    const leftValues = finiteAtomValues(left, safeFlags);
    const rightValues = finiteAtomValues(right, safeFlags);
    const candidates = new Set([
      ...ASCII_ATOM_SAMPLES,
      ...Array.from(left),
      ...Array.from(right),
      ...(leftValues ?? []),
      ...(rightValues ?? []),
    ]);
    if ([...candidates].some((sample) => leftRegex.test(sample) && rightRegex.test(sample))) {
      return true;
    }
    // A finite side proves disjointness once every value has been tested.
    // Unicode ignore-case can add folds outside that finite source enumeration.
    const hasNonExhaustiveCaseFold =
      flags.includes("i") &&
      (flags.includes("u") || flags.includes("v")) &&
      (leftValues === null || rightValues === null);
    // Unknown atom languages fail closed so sampling can never declare them safe.
    return hasNonExhaustiveCaseFold || (leftValues === null && rightValues === null);
  } catch {
    return true;
  }
}

function pathsMayOverlap(
  leftPaths: string[][],
  rightPaths: string[][],
  flags: string,
  budget: { remaining: number },
): boolean {
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      let overlaps = true;
      for (let index = 0; index < shorter.length; index += 1) {
        budget.remaining -= 1;
        if (budget.remaining < 0) {
          return true;
        }
        if (
          !atomsMayOverlap(
            expectDefined(shorter[index], "shorter alternative path atom"),
            expectDefined(longer[index], "longer alternative path atom"),
            flags,
          )
        ) {
          overlaps = false;
          break;
        }
      }
      if (overlaps) {
        return true;
      }
    }
  }
  return false;
}

export function alternativesOverlap(
  alternatives: Array<string[][] | null>,
  flags: string,
): boolean {
  if (alternatives.length > MAX_ALTERNATIVES) {
    return true;
  }
  const budget = { remaining: MAX_OVERLAP_PROBES };
  for (let leftIndex = 0; leftIndex < alternatives.length; leftIndex += 1) {
    const left = alternatives[leftIndex];
    if (!left) {
      return true;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < alternatives.length; rightIndex += 1) {
      const right = alternatives[rightIndex];
      if (!right || pathsMayOverlap(left, right, flags, budget)) {
        return true;
      }
    }
  }
  return false;
}
