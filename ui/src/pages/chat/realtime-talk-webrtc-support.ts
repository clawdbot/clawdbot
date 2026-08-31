// Control UI chat module owns low-level WebRTC offer and media-message helpers.
import { normalizeRealtimeVoiceResponseOutcome } from "../../../../src/talk/provider-types.js";
import { readResponseTextWithLimit } from "../../lib/response-body.ts";
import type {
  RealtimeTalkTranscriptItem,
  RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import type { RealtimeTalkVideoFrame } from "./realtime-talk-video.ts";

const REALTIME_WEBRTC_OFFER_TIMEOUT_MS = 30_000;
const REALTIME_TALK_DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024;
const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
  previous_item_id?: string | null;
  call_id?: string;
  name?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  arguments?: string;
  error?: unknown;
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
    output?: unknown[];
  };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    role?: string;
    content?: Array<{ type?: string }>;
  };
  turn?: {
    id?: string;
    role?: string;
    transcript?: string;
  };
};

export function realtimeTalkTranscriptItem(
  event: RealtimeServerEvent,
): RealtimeTalkTranscriptItem | undefined {
  switch (event.type) {
    case "input_audio_buffer.committed":
      return event.item_id
        ? {
            type: "created",
            itemId: event.item_id,
            previousItemId: event.previous_item_id,
            role: "user",
          }
        : undefined;
    case "conversation.item.added":
    case "conversation.item.created": {
      const item = event.item;
      if (!item?.id) {
        return undefined;
      }
      const role =
        item.type !== "message"
          ? null
          : item.role === "assistant"
            ? "assistant"
            : item.role === "user" && item.content?.some((part) => part.type === "input_audio")
              ? "user"
              : null;
      return { type: "created", itemId: item.id, previousItemId: event.previous_item_id, role };
    }
    case "conversation.item.done":
    case "response.output_item.done":
      // Interrupted responses may finish an empty assistant item without text.
      // User item completion does not complete its asynchronous ASR.
      return event.item?.id && event.item.type === "message" && event.item.role === "assistant"
        ? { type: "settled", itemId: event.item.id }
        : undefined;
    case "conversation.item.input_audio_transcription.failed":
      return event.item_id ? { type: "settled", itemId: event.item_id } : undefined;
    default:
      return undefined;
  }
}

export class RealtimeTalkResponseOutcomeOwner {
  private activeResponseId: string | undefined;
  private unkeyedSettled = false;
  private readonly settledResponseIds = new Set<string>();

  constructor(private readonly maxSettledResponses: number) {}

  start(responseId: string | undefined): void {
    this.activeResponseId = responseId;
    this.unkeyedSettled = false;
  }

  finish(event: RealtimeServerEvent) {
    const outcome =
      event.type === "response.cancelled"
        ? ({
            status: "cancelled",
            ...(event.response?.id ? { responseId: event.response.id } : {}),
          } as const)
        : normalizeRealtimeVoiceResponseOutcome({
            providerLabel: "OpenAI realtime voice",
            response: event.response,
          });
    if (
      (outcome.responseId && this.settledResponseIds.has(outcome.responseId)) ||
      (!outcome.responseId && this.unkeyedSettled) ||
      (outcome.responseId &&
        this.activeResponseId !== undefined &&
        outcome.responseId !== this.activeResponseId)
    ) {
      return undefined;
    }
    const overflow =
      outcome.responseId !== undefined && this.settledResponseIds.size >= this.maxSettledResponses;
    if (outcome.responseId && !overflow) {
      this.settledResponseIds.add(outcome.responseId);
    } else if (!outcome.responseId) {
      this.unkeyedSettled = true;
    }
    this.activeResponseId = undefined;
    return { outcome, overflow };
  }

  reset(): void {
    this.activeResponseId = undefined;
    this.unkeyedSettled = false;
    this.settledResponseIds.clear();
  }
}

type PendingOfferRequest = {
  controller: AbortController;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};

function resolveRealtimeTalkOfferUrl(offerUrl: string | undefined, gatewayUrl: string): string {
  const target = offerUrl ?? OPENAI_REALTIME_CALLS_URL;
  try {
    return new URL(target).toString();
  } catch {
    // Relative broker routes belong to the connected Gateway, which may not
    // share the Control UI document origin.
  }
  const gateway = new URL(gatewayUrl, window.location.href);
  if (gateway.protocol === "ws:") {
    gateway.protocol = "http:";
  } else if (gateway.protocol === "wss:") {
    gateway.protocol = "https:";
  }
  gateway.pathname = "/";
  gateway.search = "";
  gateway.hash = "";
  return new URL(target, gateway).toString();
}

export class RealtimeTalkWebRtcOfferExchange {
  private pendingRequest: PendingOfferRequest | null = null;

  async readAnswer(params: {
    session: RealtimeTalkWebRtcSdpSessionResult;
    offer: RTCSessionDescriptionInit;
    gatewayUrl: string;
    isCurrent: () => boolean;
  }): Promise<string | undefined> {
    const request = this.beginRequest();
    try {
      let response: Response;
      try {
        response = await fetch(
          resolveRealtimeTalkOfferUrl(params.session.offerUrl, params.gatewayUrl),
          {
            method: "POST",
            body: params.offer.sdp,
            headers: {
              ...params.session.offerHeaders,
              Authorization: `Bearer ${params.session.clientSecret}`,
              "Content-Type": "application/sdp",
            },
            signal: request.controller.signal,
          },
        );
      } catch (error) {
        if (!params.isCurrent()) {
          return undefined;
        }
        throw error;
      }
      if (!params.isCurrent()) {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(`Realtime WebRTC setup failed (${response.status})`);
      }
      let answer: string;
      try {
        const maxBytes = params.session.offerResponseMaxBytes;
        answer =
          maxBytes === undefined
            ? await response.text()
            : await readResponseTextWithLimit(response, {
                maxBytes,
                tooLargeMessage: `Realtime WebRTC SDP answer: text response exceeds ${maxBytes} bytes`,
              });
      } catch (error) {
        if (!params.isCurrent()) {
          return undefined;
        }
        throw error;
      }
      return params.isCurrent() ? answer : undefined;
    } finally {
      this.finishRequest(request);
    }
  }

  abort(): void {
    const request = this.pendingRequest;
    if (!request) {
      return;
    }
    this.pendingRequest = null;
    globalThis.clearTimeout(request.timeout);
    request.controller.abort();
  }

  private beginRequest(): PendingOfferRequest {
    this.abort();
    const controller = new AbortController();
    const request = {
      controller,
      timeout: globalThis.setTimeout(() => {
        controller.abort(
          new Error(
            `Realtime WebRTC offer request timed out after ${REALTIME_WEBRTC_OFFER_TIMEOUT_MS}ms`,
          ),
        );
      }, REALTIME_WEBRTC_OFFER_TIMEOUT_MS),
    };
    this.pendingRequest = request;
    return request;
  }

  private finishRequest(request: PendingOfferRequest): void {
    globalThis.clearTimeout(request.timeout);
    // A stopped transport may already have started a replacement request.
    // Never let the old request's finally block detach the new lifecycle owner.
    if (this.pendingRequest === request) {
      this.pendingRequest = null;
    }
  }
}

export function realtimeTalkDataChannelMaxMessageSize(peer: RTCPeerConnection | null): number {
  const negotiated = peer?.sctp?.maxMessageSize;
  return typeof negotiated === "number" && Number.isFinite(negotiated) && negotiated > 0
    ? negotiated
    : REALTIME_TALK_DEFAULT_MAX_MESSAGE_SIZE;
}

export function realtimeTalkImageEvent(frame: RealtimeTalkVideoFrame): unknown {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: `data:${frame.mimeType};base64,${frame.data}` }],
    },
  };
}
