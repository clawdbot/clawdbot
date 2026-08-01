type RouteDraftData = { sessionKey: string; draft?: string };

// A one-shot route draft belongs only to its matching pane until the page consumes it.
export function routeDraft(
  data: RouteDraftData | null | undefined,
  consumed: RouteDraftData | null,
  sessionKey = data?.sessionKey,
): string | undefined {
  return !data || sessionKey !== data.sessionKey || consumed === data ? undefined : data.draft;
}
