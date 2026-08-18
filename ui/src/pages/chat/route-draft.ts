import type { RouteLocation } from "@openclaw/uirouter";
import { SESSION_COMPOSER_FOCUS_PARAM } from "../../lib/sessions/route-navigation.ts";

type RouteDraftHint = { draft?: string; focusComposer?: boolean };
type RouteDraftData = { sessionKey: string; draft?: string };

function draftFromLocation(location: RouteLocation): string | undefined {
  return new URLSearchParams(location.search).get("draft") || undefined;
}

function focusComposerFromLocation(location: RouteLocation): boolean {
  return new URLSearchParams(location.search).get(SESSION_COMPOSER_FOCUS_PARAM) === "1";
}

export function locationWithoutDraft(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  params.delete("draft");
  params.delete(SESSION_COMPOSER_FOCUS_PARAM);
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

export function draftRouteDataFromLocation(location: RouteLocation): RouteDraftHint {
  const draft = draftFromLocation(location);
  const focusComposer = focusComposerFromLocation(location);
  return {
    draft,
    ...(focusComposer ? { focusComposer: true } : {}),
  };
}

export function draftSearchFromLocation(location: RouteLocation): string {
  const search = new URLSearchParams();
  const draft = draftFromLocation(location);
  if (draft) {
    search.set("draft", draft);
  }
  if (focusComposerFromLocation(location)) {
    search.set(SESSION_COMPOSER_FOCUS_PARAM, "1");
  }
  return search.size > 0 ? "?" + search.toString() : "";
}

// A one-shot route draft belongs only to its matching pane until the page consumes it.
export function routeDraft(
  data: RouteDraftData | null | undefined,
  consumed: RouteDraftData | null,
  sessionKey = data?.sessionKey,
): string | undefined {
  return !data || sessionKey !== data.sessionKey || consumed === data ? undefined : data.draft;
}
