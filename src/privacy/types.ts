/**
 * Privacy configuration for controlling what leaves the machine on its way
 * to an LLM inference endpoint.
 *
 * ALL traffic travels over HTTPS/TLS — there is no app-layer encryption
 * today. These settings give users control over *what* is included in the
 * cleartext payload rather than encrypting the payload itself.
 *
 * @module privacy/types
 */

/** Granular rules for a single PII category. */
export type PiiCategoryRule = {
  /** Replace matched text with a placeholder. Default: true when pii.enabled=true. */
  redact?: boolean;
  /** Custom replacement token, e.g. "[PHONE]". Defaults to the category label. */
  placeholder?: string;
};

export type PrivacyConfig = {
  /**
   * Master switch.  Set to `true` to activate all privacy filters.
   * Individual sub-sections can override specific behaviours.
   * Default: false.
   */
  enabled?: boolean;

  /**
   * Controls automatic detection and redaction of PII patterns in text that
   * flows into LLM prompts (system prompt, user messages, tool output, etc.).
   */
  pii?: {
    /**
     * Enable PII scanning.  Requires `privacy.enabled = true`.
     * Default: true when privacy.enabled=true.
     */
    enabled?: boolean;

    /**
     * Apply PII redaction to the system prompt (workspace file injections,
     * runtime info, etc.).  Default: true.
     */
    systemPrompt?: boolean;

    /**
     * Apply PII redaction to inbound user messages before they reach the LLM.
     * Default: false (redacting user input is usually undesirable).
     */
    userMessages?: boolean;

    /**
     * Apply PII redaction to tool call outputs before they are appended to
     * the conversation and sent upstream.
     * Default: true.
     */
    toolOutputs?: boolean;

    /** Per-category overrides.  Keys match the PiiCategory enum strings. */
    categories?: {
      email?: PiiCategoryRule;
      phone?: PiiCategoryRule;
      ssn?: PiiCategoryRule;
      creditCard?: PiiCategoryRule;
      ipv4?: PiiCategoryRule;
      /** Generic UUID patterns (v1-v5). */
      uuid?: PiiCategoryRule;
    };
  };

  /**
   * Controls whether image/audio/video attachments are sent to LLM providers.
   *
   * Media files (images, audio, video) are sent as base64-encoded blobs or
   * binary uploads and cannot be redacted the way text can.  The options here
   * let you either block them outright or strip EXIF metadata before upload.
   */
  media?: {
    /**
     * Drop all image/audio/video attachments before they are sent to the LLM
     * or TTS provider.  The user's text message is still sent; only the media
     * payload is discarded.
     * Default: false.
     */
    blockAttachments?: boolean;

    /**
     * Log a warning to stderr whenever a media attachment is dropped due to
     * the blockAttachments policy.
     * Default: true.
     */
    warnOnBlock?: boolean;
  };

  /**
   * Controls encryption of session transcripts stored on disk.
   *
   * Session JSONL files contain the full conversation history.  Encryption
   * uses AES-256-GCM with a key derived from the provided passphrase.
   *
   * NOTE: This section is a programmatic API only — not exposed in
   * `openclaw.yml` config validation. Use the `encryptSessionFile` /
   * `encryptSessionDirectory` functions directly. Config-driven encryption
   * will ship with a future `openclaw session encrypt` command.
   *
   * NOTE: The inference provider still receives plaintext — this only
   * protects data *at rest* on this machine.
   */
  atRest?: {
    /**
     * Enable at-rest encryption of session transcript files.
     * Default: false.
     */
    enabled?: boolean;

    /**
     * PBKDF2 passphrase used to derive the AES-256-GCM encryption key.
     * Must be set when `enabled = true`.
     * ⚠ Use an env-var reference: `${OPENCLAW_ENCRYPTION_KEY}` rather than a
     * literal value to keep the key out of the config file.
     */
    passphrase?: string;

    /**
     * Number of PBKDF2 iterations (higher = slower but stronger).
     * Default: 210_000 (OWASP recommended minimum for SHA-256 PBKDF2).
     */
    pbkdf2Iterations?: number;
  };

  /**
   * Controls how much host-identifying information appears in the system
   * prompt Runtime line that OpenClaw injects into every LLM call.
   */
  systemPrompt?: {
    /**
     * Suppress the `host=` field (machine hostname) from the Runtime line.
     * Default: false.
     */
    maskHostname?: boolean;

    /**
     * Replace the `repo=` path with just the directory basename.
     * e.g.  /home/alice/.openclaw/workspace  →  workspace
     * Default: false.
     */
    maskRepoPath?: boolean;

    /**
     * Strip OS name/version from the Runtime line.
     * Default: false.
     */
    maskOs?: boolean;

    /**
     * Strip the `shell=` field from the Runtime line.
     * Default: false.
     */
    maskShell?: boolean;

    /**
     * Completely suppress injecting workspace context files (SOUL.md,
     * AGENTS.md, USER.md, etc.) into the system prompt.
     * ⚠ This will degrade personalisation significantly.
     * Default: false.
     */
    suppressContextFiles?: boolean;
  };
};
