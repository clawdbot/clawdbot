import {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const ASTERISK_PASSWORD_PATH = "plugins.entries.voice-call.config.asterisk.password";
const SecretInputSchema = buildSecretInputSchema();

const AsteriskAudioSocketConfigSchema = z
  .object({
    /** Local interface used by the AudioSocket TCP server. */
    bind: z.string().min(1).default("127.0.0.1"),
    /** Hostname or IP Asterisk uses to reach the AudioSocket TCP server. */
    host: z.string().min(1).default("127.0.0.1"),
    /** TCP port exposed to Asterisk. */
    port: z.number().int().positive().max(65535).default(3335),
  })
  .strict()
  .default({ bind: "127.0.0.1", host: "127.0.0.1", port: 3335 });

export const AsteriskConfigSchema = z
  .object({
    /** Asterisk ARI base URL, including the /ari path. */
    baseUrl: z.string().url().optional(),
    /** ARI user from ari.conf. */
    username: z.string().min(1).optional(),
    /** ARI password from ari.conf. */
    password: SecretInputSchema.optional(),
    /** Stasis application name used for call control and events. */
    application: z.string().min(1).default("openclaw"),
    /** ARI endpoint template. {number} is replaced with the E.164 destination. */
    endpoint: z.string().min(1).optional(),
    /** AudioSocket listener and advertised address. */
    audioSocket: AsteriskAudioSocketConfigSchema,
  })
  .strict();

type AsteriskConfigValidationInput = {
  provider?: string;
  asterisk?: {
    baseUrl?: string;
    username?: string;
    password?: SecretInput;
    endpoint?: string;
  };
  outbound: { defaultMode: "notify" | "conversation" };
  realtime: { enabled: boolean };
};

export function resolveAsteriskPassword(config: AsteriskConfigValidationInput): string | undefined {
  return normalizeResolvedSecretInputString({
    value: config.asterisk?.password,
    path: ASTERISK_PASSWORD_PATH,
  });
}

export function collectAsteriskConfigErrors(config: AsteriskConfigValidationInput): string[] {
  if (config.provider !== "asterisk") {
    return [];
  }
  const errors: string[] = [];
  if (!config.asterisk?.baseUrl) {
    errors.push("plugins.entries.voice-call.config.asterisk.baseUrl is required");
  }
  if (!config.asterisk?.username) {
    errors.push("plugins.entries.voice-call.config.asterisk.username is required");
  }
  if (!hasConfiguredSecretInput(config.asterisk?.password)) {
    errors.push("plugins.entries.voice-call.config.asterisk.password is required");
  }
  if (!config.asterisk?.endpoint) {
    errors.push("plugins.entries.voice-call.config.asterisk.endpoint is required");
  } else if (!config.asterisk.endpoint.includes("{number}")) {
    errors.push(
      'plugins.entries.voice-call.config.asterisk.endpoint must contain the "{number}" placeholder',
    );
  }
  if (!config.realtime.enabled) {
    errors.push(
      "plugins.entries.voice-call.config.realtime.enabled must be true for the Asterisk AudioSocket provider",
    );
  }
  if (config.outbound.defaultMode !== "conversation") {
    errors.push(
      'plugins.entries.voice-call.config.outbound.defaultMode must be "conversation" for the Asterisk AudioSocket provider',
    );
  }
  return errors;
}
