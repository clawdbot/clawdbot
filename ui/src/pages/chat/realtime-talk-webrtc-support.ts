// Control UI chat module owns low-level WebRTC offer and media-message helpers.
import { normalizeRealtimeVoiceResponseOutcome } from "../../../../src/talk/provider-types.js";
import type { RealtimeTalkWebRtcSdpSessionResult } from "./realtime-talk-shared.ts";
import type { RealtimeTalkVideoFrame } from "./realtime-talk-video.ts";

const REALTIME_WEBRTC_OFFER_TIMEOUT_MS = 30_000;
const REALTIME_WEBRTC_SDP_ANSWER_MAX_BYTES = 256 * 1024;
const REALTIME_TALK_DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024;
const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimeServerEvent = {
  type?: string;
  item_id?: string;
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
  };
  turn?: {
    id?: string;
    role?: string;
    transcript?: string;
  };
};

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

async function readResponseTextWithLimit(
  response: Response,
  label: string,
  maxBytes?: number,
): Promise<string> {
  const rawContentLength = response.headers.get("content-length");
  if (maxBytes !== undefined && rawContentLength && /^\d+$/u.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${label}: text response exceeds ${maxBytes} bytes`);
    }
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let canceled = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }
      totalBytes += value.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        canceled = true;
        void reader.cancel().catch(() => undefined);
        throw new Error(`${label}: text response exceeds ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }
  return chunks.join("");
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
        answer = await readResponseTextWithLimit(
          response,
          "Realtime WebRTC SDP answer",
          params.session.provider === "openai" ? REALTIME_WEBRTC_SDP_ANSWER_MAX_BYTES : undefined,
        );
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
