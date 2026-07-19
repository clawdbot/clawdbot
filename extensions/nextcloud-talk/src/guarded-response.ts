// Nextcloud Talk guarded fetches own their dispatcher until the response body
// settles. Cancel unread bodies before release so streaming responses cannot
// keep the dispatcher alive after an early return.
export async function releaseNextcloudTalkGuardedResponse(params: {
  response: Response;
  release: () => Promise<void>;
}): Promise<void> {
  if (!params.response.bodyUsed) {
    await params.response.body?.cancel().catch(() => undefined);
  }
  await params.release();
}
