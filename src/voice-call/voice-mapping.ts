/**
 * Voice mapping utilities for converting between different TTS providers.
 */

/**
 * Map of OpenAI voice names to similar Twilio Polly voices.
 */
const OPENAI_TO_POLLY_MAP: Record<string, string> = {
  alloy: "Polly.Joanna", // neutral, warm
  echo: "Polly.Matthew", // male, warm
  fable: "Polly.Amy", // British, expressive
  onyx: "Polly.Brian", // deep male
  nova: "Polly.Salli", // female, friendly
  shimmer: "Polly.Kimberly", // female, clear
};

/**
 * Default Polly voice when no mapping is found.
 */
export const DEFAULT_POLLY_VOICE = "Polly.Joanna";

/**
 * Map OpenAI voice names to Twilio Polly equivalents.
 * Falls through if already a valid Polly/Google voice.
 *
 * @param voice - OpenAI voice name (alloy, echo, etc.) or Polly voice name
 * @returns Polly voice name suitable for Twilio TwiML
 */
export function mapVoiceToPolly(voice: string | undefined): string {
  if (!voice) return DEFAULT_POLLY_VOICE;

  // Already a Polly/Google voice - pass through
  if (voice.startsWith("Polly.") || voice.startsWith("Google.")) {
    return voice;
  }

  // Map OpenAI voices to Polly equivalents
  return OPENAI_TO_POLLY_MAP[voice.toLowerCase()] || DEFAULT_POLLY_VOICE;
}

/**
 * Check if a voice name is a known OpenAI voice.
 */
export function isOpenAiVoice(voice: string): boolean {
  return voice.toLowerCase() in OPENAI_TO_POLLY_MAP;
}

/**
 * Get all supported OpenAI voice names.
 */
export function getOpenAiVoiceNames(): string[] {
  return Object.keys(OPENAI_TO_POLLY_MAP);
}
