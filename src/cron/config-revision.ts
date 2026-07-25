/** Opaque revision token for cron configuration, excluding scheduler-maintained state. */
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { projectCronJobThroughStorageCodec } from "./store/row-codec.js";
import type { CronJob } from "./types.js";

function configRevisionDefinition(projected: CronJob) {
  const { updatedAtMs: _updatedAtMs, state: _state, ...definition } = projected;
  if (definition.payload.kind !== "command" || !definition.payload.env) {
    return definition;
  }

  const foldedKeys = new Set<string>();
  const hasWindowsCollision = Object.keys(definition.payload.env).some((key) => {
    const folded = key.toLowerCase();
    if (foldedKeys.has(folded)) {
      return true;
    }
    foldedKeys.add(folded);
    return false;
  });
  if (!hasWindowsCollision) {
    return definition;
  }

  // Windows resolves case-insensitive duplicate env keys in insertion order.
  // Preserve that order only when it changes command execution semantics.
  const { env, ...payload } = definition.payload;
  return { ...definition, payload: { ...payload, envEntries: Object.entries(env) } };
}

/** Hashes the job definition while preserving meaningful own-undefined config fields. */
export function resolveCronJobConfigRevision(job: CronJob): string {
  // The storage projector canonicalizes every persisted config seam. Feed it
  // neutral runtime fields so large or malformed trigger state cannot affect the token.
  const projected = projectCronJobThroughStorageCodec({ ...job, updatedAtMs: 0, state: {} });
  const fingerprint = stableStringify(configRevisionDefinition(projected));
  return `sha256:${sha256Base64Url(fingerprint)}`;
}
