// Qa Lab HTTP callers discard response bodies they do not inspect before
// releasing guarded fetch resources. Otherwise the dispatcher must destroy
// the still-streaming connection during release.
export async function discardIgnoredResponseBody(response: Response): Promise<void> {
  if (response.bodyUsed) {
    return;
  }
  await response.body?.cancel().catch(() => undefined);
}
