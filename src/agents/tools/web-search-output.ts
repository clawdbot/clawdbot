/**
 * Normalized `web_search` output contract.
 *
 * Every bundled or external provider payload is normalized at the core tool
 * boundary into one of four closed branches (error / results / answer / raw).
 * The boundary owns the untrusted-content envelope: provider prose is
 * re-wrapped here unconditionally, so no provider-controlled metadata can
 * spoof the trust marker and transport-specific extras never reach the model.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Static } from "typebox";
import { Type } from "typebox";
import { wrapWebContent } from "../../security/external-content.js";

const WebSearchExternalContentSchema = Type.Object(
  {
    untrusted: Type.Literal(true),
    source: Type.Literal("web_search"),
    wrapped: Type.Literal(true),
    provider: Type.String(),
  },
  { additionalProperties: false },
);
type WebSearchExternalContent = Static<typeof WebSearchExternalContentSchema>;

const WebSearchResultSchema = Type.Object(
  {
    title: Type.String(),
    url: Type.String(),
    snippet: Type.Optional(Type.String()),
    published: Type.Optional(Type.String()),
    siteName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const WebSearchCitationSchema = Type.Object(
  {
    url: Type.String(),
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WebSearchOutputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("error"),
      provider: Type.String(),
      error: Type.Literal("provider_error"),
      message: Type.String(),
      docs: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("results"),
      provider: Type.String(),
      query: Type.String(),
      count: Type.Number(),
      tookMs: Type.Optional(Type.Number()),
      results: Type.Array(WebSearchResultSchema),
      externalContent: WebSearchExternalContentSchema,
      cached: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("answer"),
      provider: Type.String(),
      query: Type.String(),
      tookMs: Type.Optional(Type.Number()),
      content: Type.String(),
      citations: Type.Optional(Type.Array(WebSearchCitationSchema)),
      externalContent: WebSearchExternalContentSchema,
      cached: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  // Compatibility branch: external SDK providers may return payloads that fit
  // none of the branches above. Their data passes through verbatim, as shipped
  // behavior always did, instead of being converted into a synthetic error.
  Type.Object(
    {
      kind: Type.Literal("raw"),
      provider: Type.String(),
      data: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
]);

type WebSearchOutput = Static<typeof WebSearchOutputSchema>;

// Matches well-formed envelope framing from wrapExternalContent. Provider text
// is stripped of any existing (or forged) envelopes before the boundary applies
// its own, so output carries exactly one provable envelope per field. The
// source header is consumed only when it directly follows an opening marker;
// ordinary prose like "Source: Reuters" is content, not framing.
const ENVELOPE_OPEN_RE =
  /^[ \t]*<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>[ \t]*\r?\n(?:Source: [^\n]*\r?\n---\r?\n)?/gmu;
const ENVELOPE_END_RE = /^[ \t]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>[ \t]*\r?\n?/gmu;

function unwrapEnvelopes(value: string): string {
  return value.replace(ENVELOPE_OPEN_RE, "").replace(ENVELOPE_END_RE, "").trim();
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// URLs are emitted canonicalized (percent-encoded), so whitespace or readable
// prose smuggled into a URL slot cannot ride outside the envelope as-is.
function toHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
// Purely structural date charset; free-form dates could smuggle instructions.
const PUBLISHED_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]{0,20})?$/u;

function wrapProse(value: string): string {
  const inner = unwrapEnvelopes(value);
  return inner.length === 0 ? "" : wrapWebContent(inner, "web_search");
}

function externalContentStamp(provider: string): WebSearchExternalContent {
  return { untrusted: true, source: "web_search", wrapped: true, provider };
}

function normalizeCitations(value: unknown): Array<{ url: string; title?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  // A citation url must actually parse as http(s); free text in a url slot
  // would bypass the untrusted-content envelope.
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const url = toHttpUrl(entry);
      return url ? [{ url }] : [];
    }
    const url = isRecord(entry) && typeof entry.url === "string" ? toHttpUrl(entry.url) : undefined;
    if (!isRecord(entry) || !url) {
      return [];
    }
    const citation: Static<typeof WebSearchCitationSchema> = { url };
    if (typeof entry.title === "string") {
      citation.title = wrapProse(entry.title);
    }
    return [citation];
  });
}

// Provider output is untrusted third-party data (bundled or, worse, external
// plugin code). Snapshot it into plain JSON before reading any field so exotic
// values a real HTTP payload never has — bigint, circular refs, throwing
// getters, Proxy traps — cannot crash the agent turn or vary between reads. A
// payload that will not serialize degrades to a safe provider error rather than
// throwing out of the boundary.
function snapshotProviderResult(result: Record<string, unknown>): Record<string, unknown> | null {
  try {
    // Serialize-then-parse, not structuredClone: we specifically want non-JSON
    // values (bigint, circular refs, functions, symbols) to flatten or throw
    // here rather than survive and break a later serialization. structuredClone
    // preserves them, so it would only move the crash downstream.
    const serialized = JSON.stringify(result ?? {});
    const cloned: unknown = JSON.parse(serialized);
    return isRecord(cloned) ? cloned : {};
  } catch {
    return null;
  }
}

/** Normalizes every bundled or external provider payload at the core tool boundary. */
export function normalizeWebSearchOutput(params: {
  result: Record<string, unknown>;
  provider: string;
  query: string;
}): WebSearchOutput {
  const { provider } = params;
  const result = snapshotProviderResult(params.result);
  if (!result) {
    return {
      kind: "error",
      provider,
      error: "provider_error",
      message: wrapProse("web_search provider returned a value that could not be normalized."),
    };
  }
  const tookMs = readFiniteNumber(result.tookMs);
  const cached = result.cached === true ? true : undefined;
  // The model's own request query is authoritative; provider echoes are
  // untrusted text and add nothing the model does not already know.
  const query = params.query;

  // A declared error always wins: providers never mix an error key into
  // success payloads, so treating it as failure first prevents an error plus
  // empty results from masquerading as a successful search.
  if (Object.hasOwn(result, "error")) {
    // Error branches carry no externalContent marker, so nothing provider-
    // controlled may pass unwrapped: the structured code is a core literal,
    // the raw provider code and message travel inside the envelope, and docs
    // must canonicalize as http(s).
    // Non-string error payloads (numbers, objects) keep their diagnostics by
    // serializing into the wrapped message instead of collapsing to a bare code.
    const rawError =
      typeof result.error === "string"
        ? result.error
        : truncateUtf16Safe(JSON.stringify(result.error) ?? "provider_error", 2_000);
    const rawMessage = typeof result.message === "string" ? result.message : rawError;
    const docs = typeof result.docs === "string" ? toHttpUrl(result.docs) : undefined;
    return {
      kind: "error",
      provider,
      error: "provider_error",
      message: wrapProse(rawMessage === rawError ? rawError : `${rawError}: ${rawMessage}`),
      ...(docs ? { docs } : {}),
    };
  }

  // A results branch requires conforming rows; anything else is preserved as
  // raw so nonstandard external payloads are never silently gutted.
  // Array.from densifies holes into undefined so sparse arrays cannot slip
  // past row conformance and serialize as null rows.
  const rows = Array.isArray(result.results) ? Array.from(result.results) : undefined;
  const conformingRows = rows?.every(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      typeof entry.title === "string" &&
      typeof entry.url === "string" &&
      toHttpUrl(entry.url) !== undefined,
  );
  if (rows && conformingRows) {
    const results = rows.map((row) => {
      const snippet =
        typeof row.snippet === "string"
          ? row.snippet
          : typeof row.description === "string"
            ? row.description
            : Array.isArray(row.snippets)
              ? row.snippets.find((value): value is string => typeof value === "string")
              : undefined;
      const published =
        typeof row.published === "string" && PUBLISHED_RE.test(row.published)
          ? row.published
          : undefined;
      const normalizedRow: Static<typeof WebSearchResultSchema> = {
        title: wrapProse(row.title as string),
        url: toHttpUrl(row.url as string) as string,
      };
      if (snippet !== undefined) {
        normalizedRow.snippet = wrapProse(snippet);
      }
      if (published !== undefined) {
        normalizedRow.published = published;
      }
      if (typeof row.siteName === "string") {
        normalizedRow.siteName = wrapProse(row.siteName);
      }
      return normalizedRow;
    });
    return {
      kind: "results",
      provider,
      query,
      count: readFiniteNumber(result.count) ?? results.length,
      ...(tookMs !== undefined ? { tookMs } : {}),
      results,
      externalContent: externalContentStamp(provider),
      ...(cached ? { cached } : {}),
    };
  }

  if (typeof result.content === "string") {
    const citations = normalizeCitations(result.citations);
    return {
      kind: "answer",
      provider,
      query,
      ...(tookMs !== undefined ? { tookMs } : {}),
      content: wrapProse(result.content),
      ...(citations !== undefined ? { citations } : {}),
      externalContent: externalContentStamp(provider),
      ...(cached ? { cached } : {}),
    };
  }

  return { kind: "raw", provider, data: result };
}
