// Control UI module implements browser redact behavior.
const PAYMENT_CREDENTIAL_KEYS =
  "card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|securityCode|payment[-_]?credential|paymentCredential|shared[-_]?payment[-_]?token|sharedPaymentToken";

const SECRET_DETAIL_PATTERNS: RegExp[] = [
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN)\b\s*[=:]\s*(["']?)([^\s"'\\&<>]+)\1/gi,
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN)\b\s*[=:]\s*\\+(["'])([^\s"'\\&<>]+)\\+\1/gi,
  new RegExp(
    `[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature|${PAYMENT_CREDENTIAL_KEYS})=([^&\\s"'<>]+)`,
    "gi",
  ),
  /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token)"\s*:\s*"([^"]+)"/gi,
  /(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2/gi,
  /(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2/gi,
  new RegExp(
    `--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd|${PAYMENT_CREDENTIAL_KEYS})\\s+(["']?)([^\\s"']+)\\1`,
    "gi",
  ),
  /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/gi,
  /Authorization\s*[:=]\s*Basic\s+([A-Za-z0-9+/=]+)/gi,
  /(?:X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token)\s*[:=]\s*([^\s"',;]+)/gi,
  /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/gi,
  new RegExp(
    `(^|[\\s,;])(?:access_token|refresh_token|auth[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|token|secret|password|passwd|${PAYMENT_CREDENTIAL_KEYS})=([^\\s&#]+)`,
    "gi",
  ),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(xapp-[A-Za-z0-9-]{10,})\b/g,
  /\b(gsk_[A-Za-z0-9_-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/g,
  /\b(ya29\.[0-9A-Za-z_\-./+=]{10,})\b/g,
  /\b(1\/\/0[0-9A-Za-z_\-./+=]{10,})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /\b(pplx-[A-Za-z0-9_-]{10,})\b/g,
  /\b(npm_[A-Za-z0-9]{10,})\b/g,
  /\b(AKID[A-Za-z0-9]{10,})\b/g,
  /\b(LTAI[A-Za-z0-9]{10,})\b/g,
  /\b(hf_[A-Za-z0-9]{10,})\b/g,
  /\b(r8_[A-Za-z0-9]{10,})\b/g,
  /\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
];

function redactToken(value: string): string {
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n...redacted...\n${lines[lines.length - 1]}`;
}

export function redactToolDetail(detail: string): string {
  let redacted = detail;
  for (const pattern of SECRET_DETAIL_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: string[]) => {
      const match = args[0] ?? "";
      if (match.includes("PRIVATE KEY-----")) {
        return redactPemBlock(match);
      }
      const groups = args.slice(1, -2);
      const token = groups.findLast((group) => typeof group === "string" && group.length > 0);
      return token ? match.replace(token, redactToken(token)) : "***";
    });
  }
  return redacted;
}

export const redactToolPayloadText = redactToolDetail;
