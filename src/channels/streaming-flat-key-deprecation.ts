// Warn-once state for the deprecated flat streaming key fallback in streaming.ts.
// Lives outside streaming.ts so the test-only reset stays off the public SDK
// surface (openclaw/plugin-sdk/channel-outbound re-exports all of streaming.ts).
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("channels/streaming");
const warnedFlatStreamingKeys = new Set<string>();

/** @internal Test-only reset for the flat streaming key deprecation warning cache. */
export function resetFlatStreamingKeyDeprecationWarningsForTest(): void {
  warnedFlatStreamingKeys.clear();
}

/** Warns once per process per flat key when a resolver used the flat fallback. */
export function warnFlatStreamingKeyFallback(flatKey: string, nestedPath: string): void {
  if (warnedFlatStreamingKeys.has(flatKey)) {
    return;
  }
  warnedFlatStreamingKeys.add(flatKey);
  log.warn(
    `Flat channel streaming key "${flatKey}" is deprecated; move it to streaming.${nestedPath}. The flat fallback is removed after the next release train.`,
  );
}
