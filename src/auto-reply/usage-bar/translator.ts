import { expectDefined, parseStrictInteger } from "@openclaw/normalization-core";
export type UsageBarTemplate = Record<string, unknown>;
export type UsageContract = Record<string, unknown>;
type Vocab = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function toGlyphs(scale: unknown): string[] {
  if (Array.isArray(scale)) {
    return scale.filter((g): g is string => typeof g === "string");
  }
  if (typeof scale === "string") {
    return Array.from(scale);
  }
  return [];
}

function num(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  if (Math.abs(n) >= 1000) {
    const v = n / 1000;
    return Math.abs(v) < 10 ? `${v.toFixed(1)}k` : `${Math.round(v)}k`;
  }
  return String(Math.trunc(n));
}

function fixed(value: unknown, digits: number): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  return n.toFixed(digits);
}

function dur(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return "";
  }
  const s = Math.max(0, Math.trunc(raw));
  if (s >= 86400) {
    return `${(s / 86400).toFixed(1)}d`;
  }
  if (s >= 3600) {
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)}h${String(m).padStart(2, "0")}m`;
  }
  return `${Math.floor(s / 60)}m`;
}

function pct(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : "";
}

function inv(value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return value;
  }
  return 100 - Math.max(0, Math.min(100, n));
}

function norm(value: unknown): number {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, n)) / 100;
}

function meter(value: unknown, width: number, scale: unknown): string {
  const glyphs = toGlyphs(scale);
  if (glyphs.length < 2 || width < 1) {
    return "";
  }
  const empty = expectDefined(glyphs[0], "glyphs entry at 0");
  const full = expectDefined(glyphs[glyphs.length - 1], "glyphs entry at glyphs.length 1");
  const total = norm(value) * width;
  const fullc = Math.trunc(total);
  const cells: string[] = [];
  for (let i = 0; i < Math.min(fullc, width); i++) {
    cells.push(full);
  }
  if (cells.length < width) {
    cells.push(
      expectDefined(
        glyphs[Math.round((total - fullc) * (glyphs.length - 1))],
        "glyphs entry at math.round((total fullc) * (glyphs.length 1))",
      ),
    );
  }
  while (cells.length < width) {
    cells.push(empty);
  }
  return cells.slice(0, width).join("");
}

const VERB_NAMES = new Set(["num", "fixed", "dur", "pct", "inv", "alias", "meter"]);

function parseFixedDigits(raw: string | undefined): number | undefined {
  const digits = raw === undefined ? 2 : parseStrictInteger(raw);
  return digits !== undefined && digits >= 0 && digits <= 100 ? digits : undefined;
}

function applyVerb(name: string, args: string[], value: unknown, vocab: Vocab): unknown {
  switch (name) {
    case "num":
      return num(value);
    case "fixed": {
      const digits = parseFixedDigits(args[0]);
      return digits === undefined ? "" : fixed(value, digits);
    }
    case "dur":
      return dur(value);
    case "pct":
      return pct(value);
    case "inv":
      return inv(value);
    case "alias": {
      const aliases = isObject(vocab["_aliases"]) ? vocab["_aliases"] : {};
      const table =
        args[0] && isObject(aliases[args[0]]) ? (aliases[args[0]] as Record<string, unknown>) : {};
      const key = String(value);
      if (Object.hasOwn(table, key)) {
        return table[key];
      }
      const lower = key.toLowerCase();
      return Object.hasOwn(table, lower) ? table[lower] : value;
    }
    case "meter": {
      const width = args[0] ? Number.parseInt(args[0], 10) || 5 : 5;
      const scale = args.length > 1 ? vocab[expectDefined(args[1], "args entry at 1")] : undefined;
      return meter(value, width, scale);
    }
    default:
      return String(value);
  }
}

function getPath(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (!isObject(cur)) {
      return undefined;
    }
    cur = cur[part];
    if (cur === null || cur === undefined) {
      return undefined;
    }
  }
  return cur;
}

const TOKEN = /\{([^}]+)\}/g;

function interp(text: string, ctx: unknown, vocab: Vocab): string {
  return text.replace(TOKEN, (_match, body: string) => {
    const parts = body.split("|");
    let val = getPath(ctx, (parts[0] ?? "").trim());
    const ops: Array<{ name: string; args: string[] }> = [];
    let fallback: string | undefined;
    for (const segRaw of parts.slice(1)) {
      const seg = segRaw.trim();
      const name = expectDefined(seg.split(":")[0], 'seg.split(":") entry at 0');
      if (VERB_NAMES.has(name)) {
        ops.push({ name, args: seg.split(":").slice(1) });
      } else {
        fallback = seg;
      }
    }
    if (val === null || val === undefined || val === "") {
      return fallback ?? "";
    }
    for (const op of ops) {
      val = applyVerb(op.name, op.args, val, vocab);
    }
    return String(val);
  });
}

type Segment = Record<string, unknown>;

function renderSegment(seg: Segment, ctx: unknown, vocab: Vocab): string | null {
  if ("when" in seg) {
    const v = getPath(ctx, String(seg.when));
    if (v === null || v === undefined || v === false || v === "") {
      return null;
    }
  }
  if ("map" in seg) {
    const v = getPath(ctx, String(seg.map));
    const key = typeof v === "boolean" ? String(v) : String(v);
    const cases = isObject(seg.cases) ? seg.cases : {};
    const hit = Object.hasOwn(cases, key) ? cases[key] : cases["_default"];
    return typeof hit === "string" ? hit : null;
  }
  if ("each" in seg) {
    const arr = getPath(ctx, String(seg.each));
    const items = Array.isArray(arr) ? arr : [];
    const itemTpl = typeof seg.item === "string" ? seg.item : "";
    const names = Array.isArray(seg.item_scales) ? (seg.item_scales as string[]) : undefined;
    const parts: string[] = [];
    items.forEach((el, i) => {
      let iv = vocab;
      if (names && names.length > 0) {
        iv = {
          ...vocab,
          "*": vocab[
            expectDefined(
              names[Math.min(i, names.length - 1)],
              "names entry at math.min(i, names.length 1)",
            )
          ],
        };
      }
      const r = interp(itemTpl, el, iv);
      if (r) {
        parts.push(r);
      }
    });
    const join = typeof seg.join === "string" ? seg.join : " ";
    const body = parts.join(join);
    if (!body) {
      return null;
    }
    const prefix = typeof seg.text === "string" ? seg.text : "";
    return prefix ? `${prefix} ${body}` : body;
  }
  if ("text" in seg) {
    return interp(String(seg.text), ctx, vocab) || null;
  }
  return null;
}

function resolveLayout(
  template: UsageBarTemplate,
  surface: unknown,
): { sep: string; pieces: Segment[] } {
  const output = template.output;
  if (isObject(output)) {
    const surfaces = isObject(output.surfaces) ? output.surfaces : {};
    let pieces = typeof surface === "string" ? surfaces[surface] : undefined;
    if (pieces === undefined) {
      pieces = output.default;
    }
    const sep = typeof output.sep === "string" ? output.sep : "";
    return { sep, pieces: Array.isArray(pieces) ? (pieces as Segment[]) : [] };
  }
  const ov =
    typeof surface === "string" &&
    isObject(template.surfaces) &&
    isObject(template.surfaces[surface])
      ? template.surfaces[surface]
      : {};
  const sep =
    typeof ov.sep === "string" ? ov.sep : typeof template.sep === "string" ? template.sep : " ";
  const segments = Array.isArray(ov.segments)
    ? ov.segments
    : Array.isArray(template.segments)
      ? template.segments
      : [];
  return { sep, pieces: segments as Segment[] };
}

export function renderUsageBar(template: UsageBarTemplate, contract: UsageContract): string {
  try {
    const { sep, pieces } = resolveLayout(template, contract.surface);
    const vocab: Vocab = {
      ...(isObject(template.ramps) ? template.ramps : {}),
      ...(isObject(template.series) ? template.series : {}),
      ...(isObject(template.scales) ? template.scales : {}),
    };
    vocab["_aliases"] = isObject(template.aliases) ? template.aliases : {};
    const out: string[] = [];
    for (const piece of pieces) {
      if (isObject(piece)) {
        const r = renderSegment(piece, contract, vocab);
        if (r) {
          out.push(r);
        }
      }
    }
    return out.join(sep);
  } catch {
    return "";
  }
}
