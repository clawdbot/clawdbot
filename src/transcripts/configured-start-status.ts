import {
  TRANSCRIPTS_PAGE_MAX,
  type TranscriptsStatusResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { transcriptCaptureConfigHash } from "./config-reload.js";
import type { TranscriptsConfig } from "./config.js";

type StartDiagnostic = NonNullable<
  TranscriptsStatusResult["configuredSources"][number]["startDiagnostic"]
>;
type StartFact = { lifecycleToken: symbol; diagnostic?: StartDiagnostic };
type ConfiguredStarts = {
  configHash: string;
  entries: Map<number, StartFact>;
};

// One Gateway service owns this bounded process snapshot. It is never persisted
// or used to authorize capture, stop, or recovery of an archived session.
let current: ConfiguredStarts | undefined;

export function beginConfiguredTranscriptStarts(config: TranscriptsConfig | undefined) {
  const owner: ConfiguredStarts = {
    configHash: transcriptCaptureConfigHash(config),
    entries: new Map(),
  };
  current = owner;
  return {
    record(index: number, lifecycleToken: symbol, diagnostic?: StartDiagnostic) {
      if (current === owner && index < TRANSCRIPTS_PAGE_MAX) {
        owner.entries.set(index, { lifecycleToken, diagnostic });
      }
    },
    clear() {
      if (current === owner) {
        current = undefined;
      }
    },
  };
}

export function readConfiguredTranscriptStarts(config: TranscriptsConfig | undefined) {
  return current && current.configHash === transcriptCaptureConfigHash(config)
    ? new Map(current.entries)
    : undefined;
}
