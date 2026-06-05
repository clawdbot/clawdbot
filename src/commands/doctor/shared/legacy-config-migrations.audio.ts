// Legacy audio config migrations for retired transcription command settings.
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mapLegacyAudioTranscription,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

function applyLegacyAudioTranscriptionModel(params: {
  raw: Record<string, unknown>;
  source: unknown;
  changes: string[];
  movedMessage: string;
  alreadySetMessage: string;
  invalidMessage: string;
}) {
  const mapped = mapLegacyAudioTranscription(params.source);
  if (!mapped) {
    params.changes.push(params.invalidMessage);
    return;
  }
  const tools = ensureRecord(params.raw, "tools");
  const media = ensureRecord(tools, "media");
  const mediaAudio = ensureRecord(media, "audio");
  const models = Array.isArray(mediaAudio.models) ? (mediaAudio.models as unknown[]) : [];
  if (models.length === 0) {
    mediaAudio.enabled = true;
    mediaAudio.models = [mapped];
    params.changes.push(params.movedMessage);
    return;
  }
  params.changes.push(params.alreadySetMessage);
}

/** Legacy config migration specs for audio/tool media config. */
export const LEGACY_CONFIG_MIGRATIONS_AUDIO: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "audio.transcription-v2",
    describe: "Move audio.transcription to tools.media.audio.models",
    apply: (raw, changes) => {
      const audio = getRecord(raw.audio);
      if (audio?.transcription === undefined) {
        return;
      }

      applyLegacyAudioTranscriptionModel({
        raw,
        source: audio.transcription,
        changes,
        movedMessage: "Moved audio.transcription → tools.media.audio.models.",
        alreadySetMessage: "Removed audio.transcription (tools.media.audio.models already set).",
        invalidMessage: "Removed audio.transcription (invalid or empty command).",
      });
      delete audio.transcription;
      if (Object.keys(audio).length === 0) {
        delete raw.audio;
      } else {
        raw.audio = audio;
      }
    },
  }),
];
