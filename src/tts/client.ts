import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TTSProgressCallback, TTSRequest, TTSResponse } from "./types.js";

const MINIMAX_API_URL = "https://api.minimax.io/v1/t2a_v2";
const DEFAULT_MODEL = "speech-2.6-hd";
const DEFAULT_MAX_CHARS = 9500;
const DEFAULT_TIMEOUT_SEC = 30;

interface MiniMaxResponse {
  data?: {
    audio?: string;
  };
  base_resp?: {
    status_code: number;
  };
}

export class MiniMaxTTSClient {
  private apiKey: string;
  private groupId: string;
  private cacheDir: string;
  private cacheTtlSec: number;
  private maxChars: number;
  private timeoutMs: number;
  private cacheDirInitialized = false;

  constructor(opts: {
    apiKey: string;
    groupId?: string;
    cacheTtlSec?: number;
    maxChars?: number;
    timeoutSec?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.groupId = opts.groupId || "default";
    this.cacheTtlSec = opts.cacheTtlSec || 604800; // 7 days
    this.maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
    this.timeoutMs = (opts.timeoutSec || DEFAULT_TIMEOUT_SEC) * 1000;

    // Cache directory: ~/.clawdis/cache/tts/
    // Will be initialized async on first use
    this.cacheDir = path.join(os.homedir(), ".clawdis", "cache", "tts");
  }

  /**
   * Ensure cache directory exists (async)
   */
  private async ensureCacheDir(): Promise<void> {
    if (this.cacheDirInitialized) {
      return;
    }
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      this.cacheDirInitialized = true;
    } catch (err) {
      console.error(`[tts] Failed to create cache directory: ${err}`);
      throw new Error(`Cache directory initialization failed: ${err}`);
    }
  }

  /**
   * Generate hash for cache key (full SHA-256 for collision resistance)
   */
  private getHash(text: string, voiceId: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(text + voiceId);
    return hash.digest("hex");
  }

  /**
   * Get cached audio path if exists and not expired
   */
  private async getCachedPath(hash: string): Promise<string | null> {
    const cachePath = path.join(this.cacheDir, `${hash}.mp3`);
    try {
      const stats = await fs.stat(cachePath);
      const ageSec = (Date.now() - stats.mtimeMs) / 1000;
      if (ageSec <= this.cacheTtlSec) {
        return cachePath;
      }
    } catch (err) {
      // File doesn't exist or we can't read it
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[tts] Cache access error for ${hash.slice(0, 8)}...: ${err}`);
      }
      return null;
    }
    return null;
  }

  /**
   * Validate and sanitize input text
   */
  private sanitizeText(text: string): { sanitized: string; error?: string } {
    if (!text || typeof text !== "string") {
      return { sanitized: "", error: "Text must be a non-empty string" };
    }

    // Remove control characters except newlines, tabs, carriage returns
    const sanitized = text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
    const trimmed = sanitized.trim();

    if (trimmed.length === 0) {
      return { sanitized: "", error: "Text is empty or contains only whitespace" };
    }

    if (trimmed.length < 5) {
      return { sanitized: "", error: "Text too short for TTS (minimum 5 characters)" };
    }

    return { sanitized: trimmed };
  }

  /**
   * Truncate text to max length
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  }

  /**
   * Validate hex string format
   */
  private validateHex(hex: string): { valid: boolean; error?: string } {
    const trimmed = hex.trim();
    if (!/^[0-9a-fA-F]*$/.test(trimmed)) {
      return { valid: false, error: "Invalid hex format" };
    }
    if (trimmed.length % 2 !== 0) {
      return { valid: false, error: "Invalid hex length (must be even)" };
    }
    // Check reasonable size (hex is 2x bytes, so 10MB hex = 5MB audio)
    const maxHexSize = 10 * 1024 * 1024; // 10MB hex
    if (trimmed.length > maxHexSize) {
      return { valid: false, error: "Audio data too large" };
    }
    return { valid: true };
  }

  /**
   * Redact sensitive information from error messages
   */
  private redactError(message: string): string {
    return message.replace(/Bearer\s+[^\s"]+/g, "Bearer [REDACTED]");
  }

  /**
   * Synthesize text to audio file
   */
  async synthesize(
    req: TTSRequest,
    onProgress?: TTSProgressCallback,
  ): Promise<TTSResponse> {
    const {
      text,
      model = DEFAULT_MODEL,
      voiceId = "English_CalmWoman",
      emotion = "fluent",
      speed = 1.0,
    } = req;

    // Validate and sanitize input
    const { sanitized: cleanedText, error: sanitizeError } = this.sanitizeText(text);
    if (sanitizeError) {
      return { success: false, error: sanitizeError };
    }

    await this.ensureCacheDir();

    // Check cache
    const hash = this.getHash(cleanedText, voiceId);
    const cached = await this.getCachedPath(hash);
    if (cached) {
      await onProgress?.(100);
      return { success: true, audioPath: cached, cached: true };
    }

    // Truncate if too long (using config maxChars)
    const textToSynthesize = this.truncateText(cleanedText, this.maxChars);
    const wasTruncated = textToSynthesize.length !== cleanedText.length;

    await onProgress?.(0);

    // Call MiniMax API
    try {
      const url = new URL(MINIMAX_API_URL);
      url.searchParams.set("GroupId", this.groupId);

      const payload = {
        model,
        text: textToSynthesize,
        voice_id: voiceId,
        voice_setting: {
          speed,
          volume: 1.0,
          pitch: 0,
        },
        pronunciation_dict: [],
        emotion: emotion,
        output_format: "hex",
      };

      await onProgress?.(25);

      // Set up timeout with AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          return {
            success: false,
            error: `TTS request timeout after ${this.timeoutMs}ms`,
          };
        }
        throw fetchError;
      } finally {
        clearTimeout(timeoutId);
      }

      await onProgress?.(50);

      if (!response.ok) {
        const errorText = await response.text();
        // Log detailed error server-side, return generic error to user
        console.error(
          `[tts] MiniMax API error: ${response.status} ${this.redactError(errorText)}`,
        );
        return {
          success: false,
          error: `Failed to generate audio (HTTP ${response.status})`,
        };
      }

      const data = (await response.json()) as MiniMaxResponse;

      if (data.base_resp?.status_code !== 0) {
        console.error(`[tts] MiniMax error: ${JSON.stringify(data.base_resp)}`);
        return {
          success: false,
          error: "Failed to generate audio",
        };
      }

      const audioHex = data.data?.audio;
      if (!audioHex) {
        return { success: false, error: "No audio data in response" };
      }

      // Validate hex format
      const hexValidation = this.validateHex(audioHex);
      if (!hexValidation.valid) {
        console.error(`[tts] Invalid audio data: ${hexValidation.error}`);
        return { success: false, error: "Invalid audio data format" };
      }

      await onProgress?.(75);

      // Decode hex to MP3
      const audioBuffer = Buffer.from(audioHex.trim(), "hex");
      const outputPath = path.join(this.cacheDir, `${hash}.mp3`);
      await fs.writeFile(outputPath, audioBuffer);

      await onProgress?.(100);

      return {
        success: true,
        audioPath: outputPath,
        cached: false,
        truncated: wasTruncated,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? this.redactError(error.message) : String(error);
      console.error(`[tts] Synthesis error: ${errorMessage}`);
      return {
        success: false,
        error: "Failed to generate audio. Please try again later.",
      };
    }
  }
}
