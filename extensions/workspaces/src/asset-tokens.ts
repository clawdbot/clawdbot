import { createHash, randomBytes } from "node:crypto";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TOKENS = 512;

type TokenEntry = { name: string; approval: string; expiresAt: number };

function approvalFingerprint(files: Record<string, string>): string {
  const canonical = Object.entries(files).toSorted(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** In-memory capabilities for one approved widget snapshot. Restart revokes all tokens. */
export class WidgetAssetTokens {
  private readonly tokens = new Map<string, TokenEntry>();

  issue(name: string, approvedFiles: Record<string, string>): string {
    const now = Date.now();
    this.prune(now);
    while (this.tokens.size >= MAX_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.tokens.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, {
      name,
      approval: approvalFingerprint(approvedFiles),
      expiresAt: now + TOKEN_TTL_MS,
    });
    return token;
  }

  expiresAt(token: string, name: string): number | null {
    return this.isIssued(token, name) ? (this.tokens.get(token)?.expiresAt ?? null) : null;
  }

  isIssued(token: string, name: string): boolean {
    const entry = this.tokens.get(token);
    if (!entry || entry.name !== name || entry.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  allows(token: string, name: string, approvedFiles: Record<string, string>): boolean {
    const entry = this.tokens.get(token);
    return this.isIssued(token, name) && entry?.approval === approvalFingerprint(approvedFiles);
  }

  private prune(now: number): void {
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
