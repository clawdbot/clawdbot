/**
 * Heuristics for identifying sensitive keys in configuration.
 * Using suffix matching to avoid false positives like 'keyboard' or 'monkey'.
 */
const SENSITIVE_KEY_SUFFIXES = [
  "key",
  "token",
  "secret",
  "password",
  "credential",
  "passphrase",
  "webhook",
];

const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 4096;

export class SecretScrubber {
  private secrets = new Set<string>();
  private regex: RegExp | null = null;

  constructor(initialSecrets: string[] = []) {
    this.add(initialSecrets);
  }

  /**
   * Adds new secrets to the scrubber.
   */
  add(secret: string | string[]): void {
    const toAdd = Array.isArray(secret) ? secret : [secret];
    let changed = false;

    for (const s of toAdd) {
      if (s && s.length >= MIN_SECRET_LENGTH && s.length <= MAX_SECRET_LENGTH) {
        if (!this.secrets.has(s)) {
          this.secrets.add(s);
          changed = true;
        }
      }
    }

    if (changed) {
      this.rebuildRegex();
    }
  }

  /**
   * Extracts secrets from a configuration object using heuristics.
   */
  extractFromConfig(config: unknown): void {
    const visited = new Set<unknown>();
    const found: string[] = [];

    const traverse = (current: unknown) => {
      if (!current || typeof current !== "object" || visited.has(current)) {
        return;
      }
      visited.add(current);

      for (const [key, value] of Object.entries(current)) {
        if (typeof value === "string") {
          const lowerKey = key.toLowerCase();
          const isSensitive = SENSITIVE_KEY_SUFFIXES.some(
            (suffix) =>
              lowerKey === suffix || lowerKey.endsWith(`_${suffix}`) || lowerKey.endsWith(suffix),
          );

          // Additional check for common camelCase/PascalCase sensitive keys without underscore
          const isCommonSensitive = /api[Kk]ey|authToken|botToken/.test(key);

          if (isSensitive || isCommonSensitive) {
            found.push(value);
          }
        } else if (value && typeof value === "object") {
          traverse(value);
        }
      }
    };

    traverse(config);
    this.add(found);
  }

  /**
   * Redacts all known secrets from the given text.
   */
  scrub(text: string): string {
    if (!text || !this.regex || this.secrets.size === 0) {
      return text;
    }
    return text.replace(this.regex, "your-key-here");
  }

  private rebuildRegex(): void {
    if (this.secrets.size === 0) {
      this.regex = null;
      return;
    }

    // Sort secrets by length descending to ensure longer secrets match before their substrings
    const sorted = Array.from(this.secrets).sort((a, b) => b.length - a.length);
    const escaped = sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.regex = new RegExp(escaped.join("|"), "gi");
  }
}

/**
 * Convenience function for one-off extraction and scrubbing.
 * @deprecated Use SecretScrubber class for production code to avoid repeated regex builds.
 */
export function extractSecrets(obj: unknown): string[] {
  const scrubber = new SecretScrubber();
  scrubber.extractFromConfig(obj);
  // We return the internals for compatibility with existing tests/code if needed,
  // but the class is preferred.
  return (scrubber as any).secrets ? Array.from((scrubber as any).secrets) : [];
}

/**
 * Convenience function for one-off scrubbing.
 * @deprecated Use SecretScrubber class for production code.
 */
export function scrubText(text: string, secrets: string[]): string {
  const scrubber = new SecretScrubber(secrets);
  return scrubber.scrub(text);
}
