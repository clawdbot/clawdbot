import { readResponseTextPrefix } from "../infra/http-body.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { escapeRegExp } from "../shared/regexp.js";

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

function collectRequestHeaderSecretValues(headers: HeadersInit): string[] {
  // Arbitrary configured headers can carry credentials. Authorization intermediaries
  // can also reflect the credential without its scheme, so redact both scoped forms.
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  return entries.flatMap(([headerName, headerValue]) => {
    if (headerValue === undefined) {
      return [];
    }
    const normalizedHeaderName = headerName.toLowerCase();
    if (normalizedHeaderName === "content-type" && headerValue === "application/json") {
      return [];
    }
    if (!AUTHORIZATION_SECRET_HEADERS.has(normalizedHeaderName)) {
      return [headerValue];
    }
    const authorization = /^\s*(\S+)\s+(.+?)\s*$/u.exec(headerValue);
    const credentialComponent = authorization?.[2];
    if (!credentialComponent) {
      return [headerValue];
    }
    const values = [headerValue, credentialComponent];
    if (authorization?.[1]?.toLowerCase() === "basic") {
      const bytes = Buffer.from(credentialComponent, "base64");
      if (
        bytes.toString("base64").replace(/=+$/u, "") === credentialComponent.replace(/=+$/u, "")
      ) {
        // RFC 7617: proxies may reflect the decoded pair or password. The first
        // colon separates them; deployed Basic credentials use UTF-8 or Latin-1.
        for (const encoding of ["utf8", "latin1"] as const) {
          const pair = bytes.toString(encoding);
          const separator = pair.indexOf(":");
          if (separator >= 0) {
            values.push(pair, pair.slice(separator + 1));
          }
        }
      }
    }
    return values;
  });
}

export function redactProviderResponseErrorText(
  text: string,
  headers: HeadersInit,
  options?: { sourceTruncated?: boolean },
): string {
  const exactRedacted = redactExactSecretValues(
    text,
    collectRequestHeaderSecretValues(headers),
    options?.sourceTruncated === true,
  );
  return redactToolPayloadText(exactRedacted);
}

export async function readProviderResponseErrorText(
  response: Response,
  limitBytes: number,
  headers: HeadersInit,
): Promise<string> {
  const result = await readResponseTextPrefix(response, limitBytes, {
    chunkTimeoutMs: 10_000,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`error body read stalled for ${chunkTimeoutMs}ms`),
  });
  return redactProviderResponseErrorText(result.text, headers, {
    sourceTruncated: result.truncated,
  });
}
