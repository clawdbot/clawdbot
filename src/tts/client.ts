import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TTSProgressCallback, TTSRequest, TTSResponse } from "./types.js";

const MINIMAX_API_URL = "https://api.minimax.io/v1/t2a_v2";
const DEFAULT_MODEL = "speech-2.6-hd";
const MAX_TEXT_LENGTH = 10000; // MiniMax limit

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

  constructor(opts: {
    apiKey: string;
    groupId?: string;
    cacheTtlSec?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.groupId = opts.groupId || "default";
    this.cacheTtlSec = opts.cacheTtlSec || 604800; // 7 days

    // Cache directory: ~/.clawdis/cache/tts/
    this.cacheDir = path.join(os.homedir(), ".clawdis", "cache", "tts");
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Generate hash for cache key
   */
  private getHash(text: string, voiceId: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(text + voiceId);
    return hash.digest("hex").slice(0, 24);
  }

  /**
   * Get cached audio path if exists and not expired
   */
  private getCachedPath(hash: string): string | null {
    const cachePath = path.join(this.cacheDir, `${hash}.mp3`);
    try {
      const stats = fs.statSync(cachePath);
      const ageSec = (Date.now() - stats.mtimeMs) / 1000;
      if (ageSec <= this.cacheTtlSec) {
        return cachePath;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Truncate text to max length
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
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

    // Check cache
    const hash = this.getHash(text, voiceId);
    const cached = this.getCachedPath(hash);
    if (cached) {
      await onProgress?.(100);
      return { success: true, audioPath: cached, cached: true };
    }

    // Truncate if too long
    const textToSynthesize = this.truncateText(text, MAX_TEXT_LENGTH);

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

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      await onProgress?.(50);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `MiniMax API error: ${response.status} ${errorText}`,
        };
      }

      const data = (await response.json()) as MiniMaxResponse;

      if (data.base_resp?.status_code !== 0) {
        return {
          success: false,
          error: `MiniMax error: ${JSON.stringify(data.base_resp)}`,
        };
      }

      const audioHex = data.data?.audio;
      if (!audioHex) {
        return { success: false, error: "No audio data in response" };
      }

      await onProgress?.(75);

      // Decode hex to MP3
      const audioBuffer = Buffer.from(audioHex.trim(), "hex");
      const outputPath = path.join(this.cacheDir, `${hash}.mp3`);
      await fs.promises.writeFile(outputPath, audioBuffer);

      await onProgress?.(100);

      return { success: true, audioPath: outputPath, cached: false };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
