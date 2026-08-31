// Discord plugin module implements shared custom-id value codecs.

/**
 * URI-component codec for values embedded in `k=v;` custom-id grammars
 * (exec approvals, model picker, command args, agent components).
 * Decode falls back to the raw value: Discord redelivers old component ids
 * indefinitely and historical values may predate strict encoding.
 */
export function encodeCustomIdComponent(value: string): string {
  return encodeURIComponent(value);
}

export function decodeCustomIdComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Minimal field escape for the versioned `occomp`/`ocmodal` grammar: only `%`
 * and the `;` field separator are escaped to preserve the 100-char custom-id
 * budget. The wire format is versioned (`e=1`); do not swap this for the URI
 * codec — in-flight component ids must keep decoding byte-exactly.
 */
export function escapeCustomIdFieldValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/;/g, "%3B");
}

export function needsCustomIdFieldEscaping(value: string): boolean {
  return /[%;]/.test(value);
}

export function unescapeCustomIdFieldValue(value: string): string {
  return value.replace(/%(25|3B)/gi, (match) => (match.toLowerCase() === "%25" ? "%" : ";"));
}
