/**
 * Audio port — abstracts inbound + outbound audio conversion operations.
 *
 * The engine defines this interface; the bridge layer provides an
 * implementation backed by `engine/utils/audio.js` functions.
 */

/** Inbound audio conversion (SILK→WAV, voice detection, duration formatting). */
export interface AudioConvertPort {
  convertSilkToWav(
    silkPath: string,
    outputDir: string,
  ): Promise<{ wavPath: string; duration: number } | null>;
  isVoiceAttachment(att: { content_type: string; filename?: string }): boolean;
  formatDuration(seconds: number): string;
}

/** Outbound audio conversion (WAV→SILK, audio detection, transcoding). */
export interface OutboundAudioPort {
  audioFileToSilkBase64(
    audioPath: string,
    directUploadFormats?: string[],
  ): Promise<string | undefined>;
  isAudioFile(pathOrUrl: string, mimeType?: string): boolean;
  shouldTranscodeVoice(filePath: string): boolean;
  waitForFile(filePath: string, maxWaitMs?: number): Promise<number>;
}
