import type { RouteLocation } from "@openclaw/uirouter";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { MissingSessionRouteData } from "./route-loader-session-reference.ts";

export type SessionRouteCandidate = {
  agentId: string;
  displayName: string;
  href: string;
  idPrefix: string;
};

export type ChatRouteData =
  | {
      kind: "session";
      sessionKey: string;
      agentId?: string;
      draft?: string;
      focusComposer?: boolean;
      dashboardExpanded?: boolean;
      face: BoardFace;
      shortId?: string;
      canonicalLocation?: RouteLocation;
      canonicalLocationReady?: Promise<RouteLocation | null>;
      canonicalLocationSource?: RouteLocation;
    }
  | {
      kind: "ambiguous";
      shortId: string;
      candidates: SessionRouteCandidate[];
      truncated: boolean;
      face: BoardFace;
    }
  | MissingSessionRouteData
  | { kind: "route-error"; message: string; face: "chat" };

export type SessionChatRouteData = Omit<
  Extract<ChatRouteData, { kind: "session" }>,
  "face" | "kind"
> & {
  face?: BoardFace;
  kind?: "session";
};
