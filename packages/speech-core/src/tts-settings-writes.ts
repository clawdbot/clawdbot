// TTS preference mutations stay off the agent prompt's read-only import path.
import path from "node:path";
import type { TtsAutoMode, TtsProvider } from "openclaw/plugin-sdk/config-contracts";
import { privateFileStoreSync } from "openclaw/plugin-sdk/security-runtime";
import { canonicalizeSpeechProviderId } from "openclaw/plugin-sdk/speech-core";
import { normalizeTtsPersonaId, readTtsPrefs, type TtsUserPrefs } from "./tts-settings.js";

function updateTtsPrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readTtsPrefs(prefsPath);
  update(prefs);
  privateFileStoreSync(path.dirname(prefsPath)).writeText(
    path.basename(prefsPath),
    JSON.stringify(prefs, null, 2),
  );
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function setTtsPersona(prefsPath: string, persona: string | null | undefined): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    next.persona = normalizeTtsPersonaId(persona) ?? null;
    prefs.tts = next;
  });
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider: canonicalizeSpeechProviderId(provider) ?? provider };
  });
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}
