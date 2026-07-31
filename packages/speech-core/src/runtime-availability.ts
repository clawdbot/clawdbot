/** Host-owned availability guard shared by every speech-core entrypoint. */

let assertRuntimeAvailable: (() => void) | undefined;

/** Installs the process-lifecycle availability guard owned by the OpenClaw host. */
export function setSpeechRuntimeAvailabilityGuard(guard: (() => void) | undefined): void {
  assertRuntimeAvailable = guard;
}

/** Throws the host's typed unavailable error when speech is configured cold. */
export function assertSpeechRuntimeAvailable(): void {
  assertRuntimeAvailable?.();
}

/** Returns false only when the installed host guard rejects speech execution. */
export function isSpeechRuntimeAvailable(): boolean {
  try {
    assertSpeechRuntimeAvailable();
    return true;
  } catch {
    return false;
  }
}
