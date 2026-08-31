// Stores voice wake trigger configuration.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readConfigMachineStateWithMetadata,
  writeConfigMachineState,
} from "../state/config-machine-state.js";

// Voice wake config stores trigger words used by local voice integrations.
type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
const VOICEWAKE_TRIGGERS_STATE_KEY = "voicewake.triggers";

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => normalizeOptionalString(w) ?? "")
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

function stateDatabaseOptions(stateDir?: string) {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

/** Return the built-in voice wake trigger list. */
export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

/** Load persisted voice wake triggers, falling back to defaults. */
export async function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig> {
  const state = readConfigMachineStateWithMetadata<string[]>(
    VOICEWAKE_TRIGGERS_STATE_KEY,
    stateDatabaseOptions(baseDir),
  );
  if (!state) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(state.value),
    updatedAtMs: Math.max(0, state.updatedAtMs),
  };
}

/** Persist the configured voice wake trigger list. */
export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  writeConfigMachineState(VOICEWAKE_TRIGGERS_STATE_KEY, sanitized, stateDatabaseOptions(baseDir));
  return loadVoiceWakeConfig(baseDir);
}
