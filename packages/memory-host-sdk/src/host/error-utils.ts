// Memory Host SDK helper module supports error utils behavior.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const SECRET_PATTERNS: RegExp[] = [
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g,
  /[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature)=([^&\s"'<>]+)/gi,
  /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"/g,
  /--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1/g,
  /Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/g,
  /\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/g,
  /(^|[\s,;])(?:access_token|refresh_token|api[-_]?key|token|secret|password|passwd)=([^\s&#]+)/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(xapp-[A-Za-z0-9-]{10,})\b/g,
  /\b(gsk_[A-Za-z0-9_-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/g,
  /\b(pplx-[A-Za-z0-9_-]{10,})\b/g,
  /\b(npm_[A-Za-z0-9]{10,})\b/g,
  /\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
];

// Redact common token/key shapes before errors leave memory host internals.
function maskToken(token: string): string {
  if (token.length < 18) {
    return "***";
  }
  return `${sliceUtf16Safe(token, 0, 6)}...${sliceUtf16Safe(token, -4)}`;
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n...redacted...\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const token = groups.findLast((value) => typeof value === "string" && value.length > 0) ?? match;
  const masked = maskToken(token);
  if (token === match) {
    return masked;
  }
  const tokenOffset = match.lastIndexOf(token);
  if (tokenOffset < 0) {
    return "***";
  }
  return `${match.slice(0, tokenOffset)}${masked}${match.slice(tokenOffset + token.length)}`;
}

function redactSensitiveText(text: string): string {
  let next = text;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (...args: string[]) =>
      redactMatch(args[0] ?? "", args.slice(1, -2)),
    );
  }
  return next;
}

/** Format unknown errors with causes while redacting likely secrets. */
export function formatErrorMessage(err: unknown): string {
  let formatted: string;
  if (err instanceof Error) {
    formatted = err.message || err.name || "Error";
    let cause: unknown = err.cause;
    const seen = new Set<unknown>([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
      } else if (typeof cause === "string") {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
  } else if (typeof err === "string") {
    formatted = err;
  } else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    formatted = String(err);
  } else {
    try {
      formatted = JSON.stringify(err);
    } catch {
      formatted = Object.prototype.toString.call(err);
    }
  }
  return redactSensitiveText(formatted);
}
