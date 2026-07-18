// Gateway RPC handlers for text-to-speech status, preferences, and conversion.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTtsSpeakParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  assertSecretOwnerAvailable,
  SecretSurfaceUnavailableError,
} from "../../secrets/runtime-degraded-state.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../tts/provider-registry.js";
import {
  getTtsPersona,
  getTtsProvider,
  isTtsEnabled,
  isTtsProviderConfigured,
  listTtsPersonas,
  resolveExplicitTtsOverrides,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setTtsEnabled,
  setTtsPersona,
  setTtsProvider,
  synthesizeSpeech,
  textToSpeech,
} from "../../tts/tts.js";
import { formatForLog } from "../ws-log.js";
import { inferSpeechMimeType } from "./speech-mime.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway request handlers for TTS status, preference mutation, and synthesis. */
export const ttsHandlers: GatewayRequestHandlers = {
  "tts.status": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const provider = getTtsProvider(config, prefsPath);
      const persona = getTtsPersona(config, prefsPath);
      const autoMode = resolveTtsAutoMode({ config, prefsPath });
      const fallbackProviders = resolveTtsProviderOrder(provider, cfg)
        .slice(1)
        .filter((candidate) => isTtsProviderConfigured(config, candidate, cfg));
      // Report configured state per provider so the UI can explain why fallback
      // order differs from the complete provider registry.
      const providerStates = listSpeechProviders(cfg).map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        configured: isTtsProviderConfigured(config, candidate.id, cfg),
      }));
      respond(true, {
        enabled: isTtsEnabled(config, prefsPath),
        auto: autoMode,
        provider,
        persona: persona?.id ?? null,
        personas: listTtsPersonas(config).map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
          provider: entry.provider,
        })),
        fallbackProvider: fallbackProviders[0] ?? null,
        fallbackProviders,
        prefsPath,
        providerStates,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.enable": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, true);
      respond(true, { enabled: true });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.disable": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, false);
      respond(true, { enabled: false });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.convert": async ({ params, respond, context }) => {
    const text = normalizeOptionalString(params.text) ?? "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const channel = normalizeOptionalString(params.channel);
      const providerRaw = normalizeOptionalString(params.provider);
      const modelId = normalizeOptionalString(params.modelId);
      const voiceId = normalizeOptionalString(params.voiceId);
      let overrides;
      try {
        // Explicit provider/model/voice requests are validated before synthesis
        // and disable fallback so preview calls fail against the requested target.
        overrides = resolveExplicitTtsOverrides({
          cfg,
          provider: providerRaw,
          modelId,
          voiceId,
        });
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
      const result = await textToSpeech({
        text,
        cfg,
        channel,
        overrides,
        disableFallback: Boolean(overrides.provider || modelId || voiceId),
      });
      if (result.success && result.audioPath) {
        respond(true, {
          audioPath: result.audioPath,
          provider: result.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  // Unlike tts.convert (gateway-local audioPath) this returns the clip inline,
  // so remote clients (mobile apps) can play it without filesystem access.
  "tts.speak": async ({ params, respond, context }) => {
    if (!validateTtsSpeakParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tts.speak params: ${formatValidationErrors(validateTtsSpeakParams.errors)}`,
        ),
      );
      return;
    }
    const text = normalizeOptionalString(params.text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "tts.speak requires text"));
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      // synthesizeSpeech enforces the same messages.tts.maxTextLength bound but
      // reports it as a synthesis failure; pre-check to return a request error.
      const maxTextLength = resolveTtsConfig(cfg).maxTextLength;
      if (text.length > maxTextLength) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `tts.speak text too long (${text.length} chars, max ${maxTextLength})`,
          ),
        );
        return;
      }
      assertSecretOwnerAvailable("capability", "tts");
      const result = await synthesizeSpeech({ text, cfg });
      const provider = normalizeOptionalString(result.provider);
      if (!result.success || !result.audioBuffer || result.audioBuffer.length === 0 || !provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS synthesis failed"),
        );
        return;
      }
      respond(true, {
        audioBase64: result.audioBuffer.toString("base64"),
        provider,
        outputFormat: result.outputFormat,
        mimeType: inferSpeechMimeType(result.outputFormat, result.fileExtension),
        fileExtension: result.fileExtension,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          formatForLog(err),
          err instanceof SecretSurfaceUnavailableError
            ? {
                details: {
                  reason: err.code,
                  ownerKind: err.ownerKind,
                  ownerId: err.ownerId,
                },
              }
            : undefined,
        ),
      );
    }
  },
  "tts.setProvider": async ({ params, respond, context }) => {
    const cfg = context.getRuntimeConfig();
    const provider = canonicalizeSpeechProviderId(
      normalizeOptionalString(params.provider) ?? "",
      cfg,
    );
    if (!provider || !getSpeechProvider(provider, cfg)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Invalid provider. Use a registered TTS provider id.",
        ),
      );
      return;
    }
    try {
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsProvider(prefsPath, provider);
      respond(true, { provider });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.personas": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const active = getTtsPersona(config, prefsPath);
      respond(true, {
        active: active?.id ?? null,
        personas: listTtsPersonas(config).map((persona) => ({
          id: persona.id,
          label: persona.label,
          description: persona.description,
          provider: persona.provider,
          fallbackPolicy: persona.fallbackPolicy,
          providers: Object.keys(persona.providers ?? {}),
        })),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.setPersona": async ({ params, respond, context }) => {
    const cfg = context.getRuntimeConfig();
    const rawPersona = normalizeOptionalString(params.persona);
    try {
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      if (!rawPersona || ["off", "none", "default"].includes(rawPersona.toLowerCase())) {
        setTtsPersona(prefsPath, null);
        respond(true, { persona: null });
        return;
      }
      const persona = listTtsPersonas(config).find(
        (entry) => entry.id === rawPersona.toLowerCase(),
      );
      if (!persona) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Invalid persona. Use a configured TTS persona id.",
          ),
        );
        return;
      }
      // Persist only the canonical configured id; labels/aliases stay in config
      // so preference files remain stable across copy changes.
      setTtsPersona(prefsPath, persona.id);
      respond(true, { persona: persona.id });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.providers": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      respond(true, {
        providers: listSpeechProviders(cfg).map((provider) => ({
          id: provider.id,
          name: provider.label,
          configured: isTtsProviderConfigured(config, provider.id, cfg),
          models: [...(provider.models ?? [])],
          voices: [...(provider.voices ?? [])],
        })),
        active: getTtsProvider(config, prefsPath),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
