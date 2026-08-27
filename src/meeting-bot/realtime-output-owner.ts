import type { RealtimeVoiceBridgeEvent } from "../talk/provider-types.js";

const STALE_RESPONSE_LIMIT = 16;
const AUDIO_DELTA_EVENTS = new Set([
  "conversation.output_audio.delta",
  "response.audio.delta",
  "response.output_audio.delta",
]);

export function createMeetingRealtimeOutputOwner() {
  let nextResponseId: string | undefined;
  let announcedResponseId: string | undefined;
  let currentResponseId: string | undefined;
  let blocked: { responseId?: string; token: symbol } | undefined;
  const staleResponseIds = new Set<string>();

  const rememberStale = (responseId: string) => {
    staleResponseIds.delete(responseId);
    staleResponseIds.add(responseId);
    while (staleResponseIds.size > STALE_RESPONSE_LIMIT) {
      const oldest = staleResponseIds.values().next().value;
      if (!oldest) {
        break;
      }
      staleResponseIds.delete(oldest);
    }
  };

  return {
    accept(responseId: string | undefined): boolean {
      if (responseId && staleResponseIds.has(responseId)) {
        return false;
      }
      if (blocked) {
        if (!blocked.responseId || !responseId || responseId === blocked.responseId) {
          return false;
        }
        blocked = undefined;
      }
      if (responseId) {
        currentResponseId = responseId;
      }
      return true;
    },
    block(): { blocked: boolean; token: symbol } {
      if (blocked) {
        return { blocked: false, token: blocked.token };
      }
      const token = Symbol("meeting-realtime-output-blocked");
      const responseId = currentResponseId ?? announcedResponseId;
      blocked = { ...(responseId ? { responseId } : {}), token };
      if (responseId) {
        rememberStale(responseId);
      }
      nextResponseId = undefined;
      return { blocked: true, token };
    },
    clearBlocked(): boolean {
      if (!blocked) {
        return false;
      }
      blocked = undefined;
      return true;
    },
    isBlockedBy(token: symbol): boolean {
      return blocked?.token === token;
    },
    noteEvent(event: RealtimeVoiceBridgeEvent): void {
      if (event.direction === "server" && event.type === "response.created" && event.responseId) {
        announcedResponseId = event.responseId;
        nextResponseId = undefined;
        return;
      }
      nextResponseId =
        event.direction === "server" && AUDIO_DELTA_EVENTS.has(event.type)
          ? (event.responseId ?? announcedResponseId)
          : undefined;
    },
    providerClear(): boolean {
      if (blocked) {
        if (!blocked.responseId) {
          blocked = undefined;
        }
        return false;
      }
      const responseId = currentResponseId ?? announcedResponseId;
      if (responseId) {
        blocked = { responseId, token: Symbol("meeting-realtime-output-blocked") };
        rememberStale(responseId);
      }
      nextResponseId = undefined;
      return true;
    },
    reset(): void {
      nextResponseId = undefined;
      announcedResponseId = undefined;
      currentResponseId = undefined;
      blocked = undefined;
      staleResponseIds.clear();
    },
    takeNextResponseId(): string | undefined {
      const responseId = nextResponseId ?? announcedResponseId;
      nextResponseId = undefined;
      return responseId;
    },
    terminal(responseId: string | undefined): boolean {
      if (!responseId || !blocked?.responseId || blocked.responseId === responseId) {
        blocked = undefined;
      }
      if (!responseId || announcedResponseId === responseId) {
        announcedResponseId = undefined;
      }
      if (responseId && currentResponseId && currentResponseId !== responseId) {
        return false;
      }
      currentResponseId = undefined;
      return true;
    },
  };
}
