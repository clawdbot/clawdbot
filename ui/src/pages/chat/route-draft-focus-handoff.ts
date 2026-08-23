import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { SessionChatRouteData } from "./route-loader.ts";

const HANDOFF_TTL_MS = 30_000;
const MAINTENANCE_MS = 15_000;
const RETRY_MS = 250;
const COMPOSER_SELECTOR = ".agent-chat__composer-combobox textarea";

type PendingHandoff = {
  expiresAt: number;
  sessionKey: string;
  sourceData: SessionChatRouteData;
};

export type ChatPaneElement = HTMLElement & {
  active?: boolean;
  discardStagedAttachments?: () => void;
  paneId?: string;
  prepareForEviction?: () => void;
  presented?: boolean;
  sessionKey?: string;
};

let pendingHandoff: PendingHandoff | undefined;

function pendingMatches(sessionKey: string, data: SessionChatRouteData): boolean {
  if (!pendingHandoff) {
    return false;
  }
  if (pendingHandoff.expiresAt <= Date.now()) {
    pendingHandoff = undefined;
    return false;
  }
  return (
    pendingHandoff.sourceData !== data &&
    areUiSessionKeysEquivalent(pendingHandoff.sessionKey, sessionKey)
  );
}

export class RouteDraftComposerFocus {
  private timer: number | undefined;
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  rendered(
    data: SessionChatRouteData | undefined,
    activeSessionKey: string | null | undefined,
    consumedData: SessionChatRouteData | null,
  ): boolean {
    const matchesActivePane = Boolean(
      data &&
      (activeSessionKey === undefined ||
        (activeSessionKey !== null &&
          areUiSessionKeysEquivalent(activeSessionKey, data.sessionKey))),
    );
    if (data && !data.draft && matchesActivePane && pendingMatches(data.sessionKey, data)) {
      pendingHandoff = undefined;
      this.maintain(data.sessionKey);
    }
    return Boolean(data?.draft && consumedData !== data && matchesActivePane);
  }

  shouldFocusPane(
    active: boolean,
    hasDraft: unknown,
    sessionKey: string,
    data?: SessionChatRouteData,
  ): boolean {
    return Boolean(
      active &&
      data &&
      ((hasDraft && data.focusComposer) || (!hasDraft && pendingMatches(sessionKey, data))),
    );
  }

  beforeDraftCleanup(data: SessionChatRouteData): void {
    if (!data.focusComposer) {
      return;
    }
    // Draft cleanup remounts the route page; carry the one-shot focus fact
    // to that final owner so focus does not die with this page instance.
    pendingHandoff = {
      expiresAt: Date.now() + HANDOFF_TTL_MS,
      sessionKey: data.sessionKey,
      sourceData: data,
    };
  }

  private maintain(sessionKey: string): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const deadline = Date.now() + MAINTENANCE_MS;
    let ownedComposer: HTMLTextAreaElement | undefined;

    const focusCurrentComposer = () => {
      if (!this.host.isConnected) {
        this.timer = undefined;
        return;
      }
      const pane = [...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
        (candidate) =>
          candidate.active &&
          candidate.sessionKey !== undefined &&
          areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
      );
      const composer = pane?.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
      const activeElement = document.activeElement;
      const focusStillOwned =
        activeElement === ownedComposer ||
        activeElement === document.body ||
        (activeElement instanceof HTMLElement && !activeElement.isConnected);

      if (composer && (!ownedComposer || focusStillOwned)) {
        composer.focus({ preventScroll: true });
        ownedComposer = composer;
      } else if (ownedComposer && !focusStillOwned) {
        this.timer = undefined;
        return;
      }

      if (Date.now() < deadline) {
        this.timer = window.setTimeout(focusCurrentComposer, RETRY_MS);
      } else {
        this.timer = undefined;
      }
    };

    focusCurrentComposer();
  }
}
