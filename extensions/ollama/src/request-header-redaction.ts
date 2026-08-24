import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { readResponseTextPrefix } from "openclaw/plugin-sdk/response-limit-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";

const AUTHORIZATION_SECRET_HEADERS = new Set(["authorization", "proxy-authorization"]);
const REDACTED_SECRET = "***";

type SecretRepresentation = [candidate: string, percentEscapesCaseInsensitive: boolean];

function collectSecretRepresentations(values: readonly string[]): SecretRepresentation[] {
  const representations = new Map<string, boolean>();
  const add = (candidate: string, percentEscapesCaseInsensitive = false) => {
    if (!candidate) {
      return;
    }
    representations.set(
      candidate,
      representations.get(candidate) === true || percentEscapesCaseInsensitive,
    );
    const jsonEscaped = JSON.stringify(candidate).slice(1, -1);
    if (jsonEscaped !== candidate) {
      representations.set(
        jsonEscaped,
        representations.get(jsonEscaped) === true || percentEscapesCaseInsensitive,
      );
    }
  };

  for (const value of values) {
    if (!value) {
      continue;
    }
    add(value);
    try {
      add(encodeURIComponent(value), true);
      add(new URLSearchParams([["value", value]]).toString().slice("value=".length), true);
    } catch {
      // Lone UTF-16 surrogates still retain raw and JSON exact-value coverage.
    }
  }

  return [...representations];
}

function secretRepresentationPattern([candidate, percentCaseInsensitive]: SecretRepresentation) {
  const source = escapeRegExp(candidate);
  if (!percentCaseInsensitive) {
    return source;
  }
  return source.replace(/%[0-9A-F]{2}/giu, (escape) =>
    escape.replace(/[A-F]/giu, (hex) => `[${hex.toUpperCase()}${hex.toLowerCase()}]`),
  );
}

function normalizePercentEscapeHexCase(value: string): string {
  return value.replace(/%[0-9A-F]{1,2}/giu, (escape) => escape.toUpperCase());
}

function redactExactSecretValues(
  text: string,
  values: readonly string[],
  sourceTruncated: boolean,
): string {
  const representations = collectSecretRepresentations(values).toSorted(
    (left, right) => right[0].length - left[0].length,
  );
  if (representations.length === 0) {
    return text;
  }
  const matcher = new RegExp(representations.map(secretRepresentationPattern).join("|"), "gu");
  const redacted = text.replace(matcher, REDACTED_SECRET);
  if (!sourceTruncated) {
    return redacted;
  }

  let longestPartialSuffix = 0;
  for (const [candidate, percentCaseInsensitive] of representations) {
    const comparableText = percentCaseInsensitive
      ? normalizePercentEscapeHexCase(redacted)
      : redacted;
    const comparableCandidate = percentCaseInsensitive
      ? normalizePercentEscapeHexCase(candidate)
      : candidate;
    let prefixLength = Math.min(comparableCandidate.length - 1, comparableText.length);
    while (
      prefixLength > longestPartialSuffix &&
      !comparableText.endsWith(comparableCandidate.slice(0, prefixLength))
    ) {
      prefixLength -= 1;
    }
    longestPartialSuffix = Math.max(longestPartialSuffix, prefixLength);
  }
  return longestPartialSuffix === 0
    ? redacted
    : `${redacted.slice(0, -longestPartialSuffix)}${REDACTED_SECRET}`;
}

function collectOllamaRequestHeaderSecretValues(
  headers: Readonly<Record<string, string>>,
): string[] {
  // Arbitrary configured headers can carry credentials. Authorization intermediaries
  // can also reflect the credential without its scheme, so redact both scoped forms.
  return Object.entries(headers).flatMap(([headerName, headerValue]) => {
    const normalizedHeaderName = headerName.toLowerCase();
    if (normalizedHeaderName === "content-type" && headerValue === "application/json") {
      return [];
    }
    if (!AUTHORIZATION_SECRET_HEADERS.has(normalizedHeaderName)) {
      return [headerValue];
    }
    const credentialComponent = /^\s*\S+\s+(.+?)\s*$/u.exec(headerValue)?.[1];
    return credentialComponent ? [headerValue, credentialComponent] : [headerValue];
  });
}

export function redactOllamaResponseErrorText(
  text: string,
  headers: Readonly<Record<string, string>>,
  options?: { sourceTruncated?: boolean },
): string {
  const exactRedacted = redactExactSecretValues(
    text,
    collectOllamaRequestHeaderSecretValues(headers),
    options?.sourceTruncated === true,
  );
  return redactToolPayloadText(exactRedacted);
}

export async function readOllamaResponseErrorText(
  response: Response,
  limitBytes: number,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await readResponseTextPrefix(response, limitBytes, {
    chunkTimeoutMs: 10_000,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`error body read stalled for ${chunkTimeoutMs}ms`),
  });
  return redactOllamaResponseErrorText(result.text, headers, {
    sourceTruncated: result.truncated,
  });
}
