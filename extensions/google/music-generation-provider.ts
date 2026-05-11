import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleGenerativeAiApiOrigin } from "./api.js";
import {
  createGoogleMusicGenerationProviderMetadata,
  DEFAULT_GOOGLE_MUSIC_MODEL,
  GOOGLE_MAX_INPUT_IMAGES,
  GOOGLE_PRO_MUSIC_MODEL,
} from "./generation-provider-metadata.js";
import { createGoogleGenAI } from "./google-genai-runtime.js";

const DEFAULT_TIMEOUT_MS = 180_000;

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateMusicResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
};

function resolveConfiguredGoogleMusicBaseUrl(req: MusicGenerationRequest): string | undefined {
  const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
  return configured ? resolveGoogleGenerativeAiApiOrigin(configured) : undefined;
}

function buildMusicPrompt(req: MusicGenerationRequest): string {
  const parts = [req.prompt.trim()];
  const lyrics = normalizeOptionalString(req.lyrics);
  if (req.instrumental === true) {
    parts.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
  }
  if (lyrics) {
    parts.push(`Lyrics:\n${lyrics}`);
  }
  return parts.join("\n\n");
}

function resolveSupportedFormats(model: string): readonly string[] {
  return model === GOOGLE_PRO_MUSIC_MODEL ? ["mp3", "wav"] : ["mp3"];
}

function resolveTrackFileName(params: { index: number; mimeType: string; model: string }): string {
  const ext =
    extensionForMime(params.mimeType)?.replace(/^\./u, "") ||
    (params.model === GOOGLE_PRO_MUSIC_MODEL ? "wav" : "mp3");
  return `track-${params.index + 1}.${ext}`;
}

function extractTracks(params: { payload: GoogleGenerateMusicResponse; model: string }): {
  tracks: GeneratedMusicAsset[];
  lyrics: string[];
} {
  const lyrics: string[] = [];
  const tracks: GeneratedMusicAsset[] = [];
  for (const candidate of params.payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const text = normalizeOptionalString(part.text);
      if (text) {
        lyrics.push(text);
        continue;
      }
      const inline = part.inlineData ?? part.inline_data;
      const data = normalizeOptionalString(inline?.data);
      if (!data) {
        continue;
      }
      const mimeType =
        normalizeOptionalString(inline?.mimeType) ||
        normalizeOptionalString(inline?.mime_type) ||
        "audio/mpeg";
      tracks.push({
        buffer: Buffer.from(data, "base64"),
        mimeType,
        fileName: resolveTrackFileName({
          index: tracks.length,
          mimeType,
          model: params.model,
        }),
      });
    }
  }
  return { tracks, lyrics };
}

export function buildGoogleMusicGenerationProvider(): MusicGenerationProvider {
  return {
    ...createGoogleMusicGenerationProviderMetadata(),
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > GOOGLE_MAX_INPUT_IMAGES) {
        throw new Error(
          `Google music generation supports at most ${GOOGLE_MAX_INPUT_IMAGES} reference images.`,
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const model = normalizeOptionalString(req.model) || DEFAULT_GOOGLE_MUSIC_MODEL;
      if (req.format) {
        const supportedFormats = resolveSupportedFormats(model);
        if (!supportedFormats.includes(req.format)) {
          throw new Error(
            `Google music generation model ${model} supports ${supportedFormats.join(", ")} output.`,
          );
        }
      }

      const client = createGoogleGenAI({
        apiKey: auth.apiKey,
        httpOptions: {
          ...(resolveConfiguredGoogleMusicBaseUrl(req)
            ? { baseUrl: resolveConfiguredGoogleMusicBaseUrl(req) }
            : {}),
          timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      });
      const response = (await client.models.generateContent({
        model,
        contents: [
          { text: buildMusicPrompt(req) },
          ...(req.inputImages ?? []).map((image) => ({
            inlineData: {
              mimeType: normalizeOptionalString(image.mimeType) || "image/png",
              data: image.buffer?.toString("base64") ?? "",
            },
          })),
        ],
        config: {
          responseModalities: ["AUDIO", "TEXT"],
        },
      })) as GoogleGenerateMusicResponse;

      const { tracks, lyrics } = extractTracks({
        payload: response,
        model,
      });
      if (tracks.length === 0) {
        throw new Error("Google music generation response missing audio data");
      }
      return {
        tracks,
        ...(lyrics.length > 0 ? { lyrics } : {}),
        model,
        metadata: {
          inputImageCount: req.inputImages?.length ?? 0,
          instrumental: req.instrumental === true,
          ...(normalizeOptionalString(req.lyrics) ? { requestedLyrics: true } : {}),
          ...(req.format ? { requestedFormat: req.format } : {}),
        },
      };
    },
  };
}
