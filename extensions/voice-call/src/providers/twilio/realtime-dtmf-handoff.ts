const REALTIME_STREAM_HANDOFF_TIMEOUT_MS = 10_000;

/**
 * Lets the realtime bridge report the provider-owned end of a bidirectional
 * stream. A Media Streams `clear` only flushes audio; it does not end a
 * `<Connect><Stream>` verb or acknowledge that TwiML playback can take over.
 */
export interface TwilioRealtimeStreamHandoff {
  waitForStreamEnd(callSid: string): Promise<void> | null;
}

export function buildRealtimeStreamHandoffTwiml(
  webhookUrl: string,
  escapeXml: (value: string) => string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="60" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;
}

export async function waitForRealtimeStreamEnd(
  callSid: string,
  streamEnded: Promise<void>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      streamEnded,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for realtime stream to end before sending DTMF for ${callSid}`,
            ),
          );
        }, REALTIME_STREAM_HANDOFF_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
