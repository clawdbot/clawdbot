import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { evaluateCredentialStewardExposure } from "./credential-steward-policy.js";

export type BrowserStewardCredentialExposureKind =
  | "none"
  | "credential_like"
  | "credential_material";

export type BrowserStewardCredentialExposureReasonCode =
  | "no_credential_material"
  | "credential_like_label"
  | "credential_material_detected";

export type BrowserStewardCredentialExposure = {
  exposureKind: BrowserStewardCredentialExposureKind;
  reasonCode: BrowserStewardCredentialExposureReasonCode;
  classes: string[];
  blocked: boolean;
};

const SIGNED_URL_QUERY_KEYS = new Set([
  "sig",
  "signature",
  "se",
  "sp",
  "sr",
  "st",
  "sv",
  "skoid",
  "sktid",
  "skt",
  "ske",
  "sks",
  "skv",
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-algorithm",
  "x-goog-credential",
  "x-goog-date",
  "x-goog-expires",
  "x-goog-signature",
]);
// OAuth callback codes and tokens are bearer-like credentials even before exchange.
const OAUTH_CREDENTIAL_QUERY_KEYS = new Set([
  "access_token",
  "auth_code",
  "authorization_code",
  "code_verifier",
  "id_token",
  "oauth_token",
  "oauth_verifier",
  "refresh_token",
]);
const OAUTH_CONTEXT_QUERY_KEYS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "iss",
  "nonce",
  "redirect_uri",
  "response_type",
  "scope",
  "session_state",
  "state",
]);
const OAUTH_CALLBACK_PATH_RE =
  /(?:^|[\\/._-])(?:auth|authorize|authorization|callback|oidc|oauth2?|signin-oidc|sso)(?:[\\/._-]|$)/iu;
const OPAQUE_CREDENTIAL_PATH_RE =
  /(?:^|\/)(?:password[-_]?reset|reset|magic[-_]?login|verify|verification|invite|invitation)\/[^/?#]+(?:\/|$)/iu;
const URL_FIELD_KEYS = new Set([
  "url",
  "href",
  "origin",
  "redirect_uri",
  "redirect_url",
  "return_url",
  "callback_url",
]);

function hasOAuthContext(parsed: URL, parameterSets: URLSearchParams[]): boolean {
  return (
    OAUTH_CALLBACK_PATH_RE.test(parsed.pathname) ||
    parameterSets.some((params) =>
      [...params.keys()].some((key) => OAUTH_CONTEXT_QUERY_KEYS.has(key.toLowerCase())),
    )
  );
}

const CREDENTIAL_CLASS_ORDER = Object.freeze([
  "api key",
  "password",
  "token",
  "cookie",
  "private key",
  "secret",
]);
const CREDENTIAL_LIKE_UPLOAD_PATH_RE =
  /(?:api[-_ ]?key|auth(?:entication)?|cookie|credential|id_rsa|password|private[-_ ]?key|secret|token|\.env(?:\.|$))/iu;

function classifyCredentialLabel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!normalized) {
    return undefined;
  }
  if (/api[-_ ]?key/.test(normalized)) {
    return "api key";
  }
  if (/password|passphrase|passwd/.test(normalized)) {
    return "password";
  }
  if (/authorization|bearer|access[-_ ]?token|refresh[-_ ]?token|\btoken\b/.test(normalized)) {
    return "token";
  }
  if (/cookie|session[-_ ]?cookie/.test(normalized)) {
    return "cookie";
  }
  if (/private[-_ ]?key|wallet/.test(normalized)) {
    return "private key";
  }
  if (/secret|credential/.test(normalized)) {
    return "secret";
  }
  return undefined;
}

function classifySignedUrl(value: string): string | undefined {
  const candidates = value.match(/\bhttps?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/g, ""));
      const parameterSets = [
        url.searchParams,
        ...(url.hash ? [new URLSearchParams(url.hash.slice(1))] : []),
      ];
      if (OPAQUE_CREDENTIAL_PATH_RE.test(url.pathname)) {
        return "token";
      }
      const oauthContext = hasOAuthContext(url, parameterSets);
      for (const params of parameterSets) {
        for (const [key, queryValue] of params) {
          if (!queryValue.trim()) {
            continue;
          }
          const normalizedKey = key.toLowerCase();
          if (normalizedKey === "client_secret") {
            return "secret";
          }
          if (
            SIGNED_URL_QUERY_KEYS.has(normalizedKey) ||
            OAUTH_CREDENTIAL_QUERY_KEYS.has(normalizedKey) ||
            (normalizedKey === "code" && oauthContext)
          ) {
            return "token";
          }
          const credentialClass = classifyCredentialLabel(key);
          if (credentialClass) {
            return credentialClass;
          }
        }
      }
    } catch {
      // Continue scanning other URL-like values.
    }
  }
  return undefined;
}

export function classifyCredentialMaterial(value: string): string | undefined {
  const signedUrlClass = classifySignedUrl(value);
  if (signedUrlClass) {
    return signedUrlClass;
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) {
    return "password";
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    return "private key";
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{4,}/i.test(value)) {
    return "token";
  }
  if (
    /\b(?:authorization|access[-_ ]?token|refresh[-_ ]?token|token)\s*[:=]\s*["']?[^\s"']{4,}/i.test(
      value,
    )
  ) {
    return "token";
  }
  if (/\bpassword\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "password";
  }
  if (/\bcookie\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "cookie";
  }
  if (/\bapi[-_ ]?key\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "api key";
  }
  if (/\bsecret\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "secret";
  }
  if (/\b(?:sk|pk)-[a-z0-9][a-z0-9._-]{8,}/i.test(value)) {
    return "api key";
  }
  if (/\b(?:xox[baprs]-|gh[pousr]_|glpat-)[a-z0-9_-]{8,}/i.test(value)) {
    return "token";
  }
  return undefined;
}

/** Identifies upload filenames that may themselves disclose or carry credentials. */
function isBrowserStewardCredentialLikeUploadPath(value: string): boolean {
  return CREDENTIAL_LIKE_UPLOAD_PATH_RE.test(value);
}

function hasCredentialLabel(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && classifyCredentialLabel(entry) !== undefined)
  );
}

function credentialFieldType(record: Record<string, unknown>): string | undefined {
  return typeof record.type === "string" ? classifyCredentialLabel(record.type) : undefined;
}

function fillFieldsHaveCredentialHint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        return false;
      }
      const record = isRecord(field) ? field : undefined;
      if (!record) {
        return false;
      }
      return (
        credentialFieldType(record) !== undefined ||
        hasCredentialLabel(record.labels) ||
        Object.keys(record).some((key) => classifyCredentialLabel(key) !== undefined)
      );
    })
  );
}

function isSensitiveBrowserInputField(record: Record<string, unknown>, key: string): boolean {
  const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  // Typed, selected, and dialog-prompt values can be opaque secrets even when
  // neither the value nor its key has a recognizable credential pattern.
  return (
    (kind === "type" && key === "text") ||
    (kind === "select" && key === "values") ||
    key === "promptText"
  );
}

function isBrowserUrlField(key: string): boolean {
  return URL_FIELD_KEYS.has(key.trim().toLowerCase().replace(/-/g, "_"));
}

function redactBrowserUrlField(value: unknown): unknown {
  if (typeof value !== "string") {
    return "REDACTED";
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "REDACTED";
    }
    return parsed.origin;
  } catch {
    return "REDACTED";
  }
}

function redactBrowserFillFields(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return "REDACTED";
  }
  const seen = new WeakMap<object, unknown>();
  const redactFieldPart = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return classifyCredentialMaterial(candidate) ? "REDACTED" : candidate;
    }
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    const cached = seen.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    if (Array.isArray(candidate)) {
      const result: unknown[] = [];
      seen.set(candidate, result);
      for (const entry of candidate) {
        result.push(redactFieldPart(entry));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(candidate, result);
    for (const [key, entry] of Object.entries(candidate)) {
      result[key] =
        key === "value"
          ? "REDACTED"
          : isBrowserUrlField(key)
            ? redactBrowserUrlField(entry)
            : redactFieldPart(entry);
    }
    return result;
  };
  return redactFieldPart(value);
}

/**
 * Preserve non-secret Browser request structure for downstream policy hooks
 * while replacing credential fields and credential-bearing strings.
 */
export function redactBrowserStewardCredentialMaterial(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return classifyCredentialMaterial(candidate) ? "REDACTED" : candidate;
    }
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    const cached = seen.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    if (Array.isArray(candidate)) {
      const result: unknown[] = [];
      seen.set(candidate, result);
      for (const entry of candidate) {
        result.push(redact(entry));
      }
      return result;
    }
    if (!isRecord(candidate)) {
      return candidate;
    }
    const record = candidate;
    const result: Record<string, unknown> = {};
    seen.set(candidate, result);
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
    const operationKind =
      kind || (typeof record.action === "string" ? record.action.trim().toLowerCase() : "");
    const labelsCredentialMaterial = hasCredentialLabel(record.labels);
    const typedCredentialMaterial = credentialFieldType(record) !== undefined;
    for (const [key, entry] of Object.entries(record)) {
      if (operationKind === "upload" && key === "paths") {
        result[key] = Array.isArray(entry) ? entry.map(() => "REDACTED") : "REDACTED";
        continue;
      }
      result[key] =
        ((kind === "evaluate" || kind === "wait") && key === "fn") ||
        classifyCredentialLabel(key) ||
        isSensitiveBrowserInputField(record, key) ||
        (typeof entry === "string" && classifyCredentialMaterial(entry)) ||
        (key === "value" && (labelsCredentialMaterial || typedCredentialMaterial))
          ? kind === "select" && key === "values" && Array.isArray(entry)
            ? entry.map(() => "REDACTED")
            : "REDACTED"
          : kind === "fill" && key === "fields"
            ? redactBrowserFillFields(entry)
            : isBrowserUrlField(key)
              ? redactBrowserUrlField(entry)
              : redact(entry);
    }
    return result;
  };
  return redact(value);
}

/** Browser output can contain opaque page data, so diagnostic copies are metadata-only. */
function hasConcreteCredentialValue(value: unknown): boolean {
  const pending = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string" && entry.trim().length > 0) {
      return true;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return true;
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    pending.push(...(Array.isArray(entry) ? entry : Object.values(entry)));
  }
  return false;
}

export function evaluateBrowserCredentialExposure(
  value: unknown,
): BrowserStewardCredentialExposure {
  const canonical = evaluateCredentialStewardExposure({ value });
  const classes = new Set(canonical.credentialClassesInvolved);
  let credentialLike = canonical.exposureKind === "credential_like";
  let material = canonical.exposureKind === "credential_material";
  const pending = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string") {
      const materialClass = classifyCredentialMaterial(entry);
      if (materialClass) {
        classes.add(materialClass);
        material = true;
      }
      continue;
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      pending.push(...entry);
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const record = entry;
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
    const operationKind =
      kind || (typeof record.action === "string" ? record.action.trim().toLowerCase() : "");
    if (
      operationKind === "upload" &&
      Array.isArray(record.paths) &&
      record.paths.some(
        (path): path is string =>
          typeof path === "string" && isBrowserStewardCredentialLikeUploadPath(path),
      )
    ) {
      classes.add("secret");
      credentialLike = true;
      material = true;
    }
    if (
      (kind === "evaluate" || kind === "wait") &&
      typeof record.fn === "string" &&
      record.fn.trim()
    ) {
      classes.add("secret");
      credentialLike = true;
      material = true;
    }
    if (
      kind === "fill" &&
      hasConcreteCredentialValue(record.fields) &&
      !fillFieldsHaveCredentialHint(record.fields)
    ) {
      classes.add("secret");
      credentialLike = true;
      material = true;
    }
    if (kind === "select" && hasConcreteCredentialValue(record.values)) {
      classes.add("secret");
      credentialLike = true;
      material = true;
    }
    const labels = Array.isArray(record.labels) ? record.labels : [];
    for (const label of labels) {
      if (typeof label !== "string") {
        continue;
      }
      const labelClass = classifyCredentialLabel(label);
      if (!labelClass) {
        continue;
      }
      classes.add(labelClass);
      credentialLike = true;
      if (hasConcreteCredentialValue(record.value)) {
        material = true;
      }
    }
    const fieldTypeClass = credentialFieldType(record);
    if (fieldTypeClass) {
      classes.add(fieldTypeClass);
      credentialLike = true;
      if (hasConcreteCredentialValue(record.value)) {
        material = true;
      }
    }
    for (const [key, nested] of Object.entries(entry)) {
      if (isSensitiveBrowserInputField(record, key)) {
        classes.add("secret");
        credentialLike = true;
        if (hasConcreteCredentialValue(nested)) {
          material = true;
        }
      }
      const labelClass = classifyCredentialLabel(key);
      if (labelClass) {
        classes.add(labelClass);
        credentialLike = true;
        if (hasConcreteCredentialValue(nested)) {
          material = true;
        }
      }
      pending.push(nested);
    }
  }
  const sortedClasses = CREDENTIAL_CLASS_ORDER.filter((entry) => classes.has(entry));
  if (material) {
    return {
      exposureKind: "credential_material",
      reasonCode: "credential_material_detected",
      classes: sortedClasses,
      blocked: true,
    };
  }
  if (credentialLike) {
    return {
      exposureKind: "credential_like",
      reasonCode: "credential_like_label",
      classes: sortedClasses,
      blocked: false,
    };
  }
  return {
    exposureKind: "none",
    reasonCode: "no_credential_material",
    classes: [],
    blocked: false,
  };
}
