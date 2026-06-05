// ACP Core helper module supports error format behavior.
const SECRET_PATTERNS: RegExp[] = [
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g,
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN)\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g,
  /[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature|card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token)=([^&\s"'<>]+)/gi,
  /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token)"\s*:\s*"([^"]+)"/g,
  /(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2/gi,
  /(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2/gi,
  /--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd|card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token)\s+(["']?)([^\s"']+)\1/gi,
  /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/gi,
  /Authorization\s*[:=]\s*Basic\s+([A-Za-z0-9+/=]+)/gi,
  /(?:X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token)\s*[:=]\s*([^\s"',;]+)/gi,
  /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/g,
  /(^|[\s,;])(?:access_token|refresh_token|auth[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|token|secret|password|passwd|card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token)=([^\s&#]+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /(ghp_[A-Za-z0-9]{20,})/g,
  /(github_pat_[A-Za-z0-9_]{20,})/g,
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /(xapp-[A-Za-z0-9-]{10,})/g,
  /(gsk_[A-Za-z0-9_-]{10,})/g,
  /(AIza[0-9A-Za-z\-_]{20,})/g,
  /(ya29\.[0-9A-Za-z_\-./+=]{10,})/g,
  /(1\/\/0[0-9A-Za-z_\-./+=]{10,})/g,
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /(pplx-[A-Za-z0-9_-]{10,})/g,
  /(npm_[A-Za-z0-9]{10,})/g,
  /(AKID[A-Za-z0-9]{10,})/g,
  /(LTAI[A-Za-z0-9]{10,})/g,
  /(hf_[A-Za-z0-9]{10,})/g,
  /(r8_[A-Za-z0-9]{10,})/g,
  /\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
];

let configuredRedactor: ((value: string) => string) | undefined;

/** Installs a host-provided redactor used before ACP fallback secret-pattern redaction. */
export function configureAcpErrorRedactor(redactor: ((value: string) => string) | undefined): void {
  configuredRedactor = redactor;
}

/** Redacts common provider, GitHub, HTTP, payment, bot, and private-key secrets from error text. */
export function redactSensitiveText(value: string): string {
  if (configuredRedactor) {
    return configuredRedactor(value);
  }
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...args: string[]) => {
      if (match.includes("PRIVATE KEY-----")) {
        return "[REDACTED_PRIVATE_KEY]";
      }
      const groups = args.slice(0, -2);
      // Replace only the captured secret when possible so surrounding diagnostics stay useful.
      const token = groups.findLast((group) => typeof group === "string" && group.length > 0);
      return token ? match.replace(token, "[REDACTED]") : "[REDACTED]";
    });
  }
  return redacted;
}

/**
 * Render a non-Error `cause` value without leaking `[object Object]` or throwing
 * while formatting nested ACP runtime failures.
 */
export function stringifyNonErrorCause(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
