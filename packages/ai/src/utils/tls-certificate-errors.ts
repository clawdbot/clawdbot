export type TlsCertificateErrorKind = "certificate_invalid" | "hostname_mismatch";

export type TlsCertificateErrorDetails = {
  kind: TlsCertificateErrorKind;
  code?: string;
  message: string;
};

const HOSTNAME_MISMATCH_CODES = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"]);

const CERTIFICATE_INVALID_CODES = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const HOSTNAME_MISMATCH_PATTERNS = [
  /hostname\/ip does not match certificate(?:'s)? altnames/i,
  /hostname mismatch/i,
  /host: .+ is not in the cert(?:ificate)?(?:'s)? altnames/i,
];

const CERTIFICATE_INVALID_PATTERNS = [
  /certificate has expired/i,
  /certificate is not yet valid/i,
  /self[- ]signed certificate/i,
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
];

const MAX_TLS_ERROR_DEPTH = 8;

function classifyCode(code: string): TlsCertificateErrorKind | null {
  if (HOSTNAME_MISMATCH_CODES.has(code)) {
    return "hostname_mismatch";
  }
  return CERTIFICATE_INVALID_CODES.has(code) ? "certificate_invalid" : null;
}

function classifyMessage(message: string): TlsCertificateErrorKind | null {
  if (HOSTNAME_MISMATCH_PATTERNS.some((pattern) => pattern.test(message))) {
    return "hostname_mismatch";
  }
  return CERTIFICATE_INVALID_PATTERNS.some((pattern) => pattern.test(message))
    ? "certificate_invalid"
    : null;
}

function inspectTlsCertificateErrorInternal(
  error: unknown,
  seen: Set<object>,
  depth: number,
): TlsCertificateErrorDetails | null {
  if (depth > MAX_TLS_ERROR_DEPTH) {
    return null;
  }
  if (typeof error === "string") {
    const kind = classifyMessage(error);
    return kind ? { kind, message: error } : null;
  }
  if (!error || typeof error !== "object" || seen.has(error)) {
    return null;
  }
  seen.add(error);

  const candidate = error as {
    cause?: unknown;
    code?: unknown;
    error?: unknown;
    errors?: unknown;
    message?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code.trim().toUpperCase() : undefined;
  const message =
    typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message
      : undefined;
  const codeKind = code ? classifyCode(code) : null;
  if (code && codeKind) {
    return {
      kind: codeKind,
      code,
      message: message ?? code,
    };
  }

  const nestedErrors = Array.isArray(candidate.errors) ? candidate.errors : [];
  for (const nested of [candidate.cause, candidate.error, ...nestedErrors]) {
    if (nested === undefined || nested === error) {
      continue;
    }
    const details = inspectTlsCertificateErrorInternal(nested, seen, depth + 1);
    if (details) {
      return details;
    }
  }

  const messageKind = message ? classifyMessage(message) : null;
  return messageKind && message ? { kind: messageKind, message } : null;
}

/** Classify deterministic Node/OpenSSL certificate validation failures. */
export function inspectTlsCertificateError(error: unknown): TlsCertificateErrorDetails | null {
  return inspectTlsCertificateErrorInternal(error, new Set<object>(), 0);
}
