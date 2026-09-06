import { describe, expect, it } from "vitest";
import {
  isActiveCall,
  isEndedCall,
  isIncomingRingingCall,
  isOutgoingRingingCall,
  isUnknownCallStatus,
  normalizeFaceTimeCallEvent,
  normalizeFaceTimeHandle,
  resolveAuthorizedFaceTimeOwner,
} from "../src/call-events.js";

const verifiedFaceTimeTransport = {
  kind: "facetime",
  classifier_version: "tu-provider-v1",
  service: 2,
  facetime_transport_type: 1,
  provider_classified: true,
  provider_is_facetime: true,
  provider_is_telephony: false,
  is_using_baseband: false,
  is_wifi_call: false,
  is_voip: true,
  is_emergency: false,
};

describe("FaceTime call events", () => {
  it("normalizes helper call-status events", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-1",
        proxy_identifier: "proxy-1",
        conversation_uuid: "conversation-1",
        conversation_group_uuid: "group-1",
        conversation_audio_enabled: true,
        conversation_video_enabled: false,
        conversation_av_mode: 1,
        conversation_resolved_audio_video_mode: "1",
        call_status: 4,
        is_outgoing: false,
        is_sending_audio: true,
        is_sending_transmission: true,
        is_sending_video: false,
        is_uplink_muted: false,
        local_meter_level: "0.37",
        remote_meter_level: 0.18,
        handle: { value: "mailto:omar@example.com" },
        transport: verifiedFaceTimeTransport,
      },
    });

    expect(event?.data.call_uuid).toBe("call-1");
    expect(event?.data.proxy_identifier).toBe("proxy-1");
    expect(event?.data.conversation_uuid).toBe("conversation-1");
    expect(event?.data.conversation_group_uuid).toBe("group-1");
    expect(event?.data.conversation_audio_enabled).toBe(true);
    expect(event?.data.conversation_video_enabled).toBe(false);
    expect(event?.data.conversation_av_mode).toBe(1);
    expect(event?.data.conversation_resolved_audio_video_mode).toBe(1);
    expect(event?.data.call_status).toBe(4);
    expect(event?.data.is_sending_audio).toBe(true);
    expect(event?.data.is_sending_transmission).toBe(true);
    expect(event?.data.is_sending_video).toBe(false);
    expect(event?.data.is_uplink_muted).toBe(false);
    expect(event?.data.local_meter_level).toBe(0.37);
    expect(event?.data.remote_meter_level).toBe(0.18);
    expect(isIncomingRingingCall(event!)).toBe(true);
    expect(isActiveCall(event!)).toBe(false);
    expect(isEndedCall(event!)).toBe(false);
  });

  it("matches configured owner handle values case-insensitively", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-1",
        call_status: 4,
        is_outgoing: false,
        handle: { value: "MAILTO:Omar@Example.com" },
        transport: verifiedFaceTimeTransport,
      },
    });

    expect(normalizeFaceTimeHandle(event?.data.handle)).toBe("MAILTO:Omar@Example.com");
    expect(
      resolveAuthorizedFaceTimeOwner({
        event: event!,
        ownerHandles: ["omar@example.com"],
      }),
    ).toEqual({ senderId: "omar@example.com", senderIsOwner: true });
  });

  it("does not grant owner authority outside the FaceTime allowlist", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-1",
        call_status: 4,
        is_outgoing: false,
        handle: { value: "stranger@example.com" },
        transport: verifiedFaceTimeTransport,
      },
    });

    expect(
      resolveAuthorizedFaceTimeOwner({
        event: event!,
        ownerHandles: ["owner@example.com"],
      }),
    ).toBeUndefined();
  });

  it("uses the exact authorized owner candidate as the authenticated sender", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-1",
        call_status: 4,
        is_outgoing: false,
        handle: {
          value: "display@example.com",
          normalized: { value: "MAILTO:owner@example.com" },
        },
        transport: verifiedFaceTimeTransport,
      },
    });

    expect(
      resolveAuthorizedFaceTimeOwner({
        event: event!,
        ownerHandles: ["owner@example.com"],
      }),
    ).toEqual({ senderId: "owner@example.com", senderIsOwner: true });
  });

  it("ignores country codes and searches nested handle dictionaries", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-1",
        call_status: 1,
        is_outgoing: false,
        handle: {
          isoCountryCode: "us",
          person: {
            handle: {
              normalizedValue: "mailto:omar@example.com",
            },
          },
        },
        transport: verifiedFaceTimeTransport,
      },
    });

    expect(normalizeFaceTimeHandle(event?.data.handle)).toBe("mailto:omar@example.com");
    expect(
      resolveAuthorizedFaceTimeOwner({ event: event!, ownerHandles: ["omar@example.com"] }),
    ).toEqual({ senderId: "omar@example.com", senderIsOwner: true });
  });

  it("requires explicit native ended evidence and fails unknown numeric states closed", () => {
    const ended = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: { call_uuid: "call-1", call_status: 6, has_ended: true },
    });
    const unknown = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: { call_uuid: "call-2", call_status: 99 },
    });

    expect(isEndedCall(ended!)).toBe(true);
    expect(isEndedCall(unknown!)).toBe(false);
    expect(isUnknownCallStatus(unknown!)).toBe(true);
  });

  it("never grants owner authority to a Phone-owned cellular call with a matching number", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "pstn-call",
        call_status: 4,
        is_outgoing: false,
        handle: { value: "+12065550123" },
        transport: {
          kind: "cellular",
          classifier_version: "tu-provider-v1",
          service: 1,
          facetime_transport_type: 0,
          provider_classified: true,
          provider_is_facetime: false,
          provider_is_telephony: true,
          is_using_baseband: false,
          is_wifi_call: true,
          is_voip: true,
          is_emergency: false,
        },
      },
    });

    expect(
      resolveAuthorizedFaceTimeOwner({ event: event!, ownerHandles: ["+12065550123"] }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "telephony provider",
      patch: { service: 1, provider_is_facetime: false, provider_is_telephony: true },
    },
    { name: "baseband", patch: { is_using_baseband: true } },
    { name: "Wi-Fi calling", patch: { is_wifi_call: true } },
    { name: "unknown provider", patch: { provider_classified: false } },
  ])("rejects a matching owner handle on $name transport", ({ patch }) => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "not-facetime",
        call_status: 4,
        handle: { value: "+12065550123" },
        transport: { ...verifiedFaceTimeTransport, ...patch },
      },
    });

    expect(
      resolveAuthorizedFaceTimeOwner({ event: event!, ownerHandles: ["+12065550123"] }),
    ).toBeUndefined();
  });

  it("keeps an outbound sending call live while it rings", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-2",
        call_status: 3,
        is_outgoing: true,
        handle: { value: "MAILTO:Owner@example.com" },
      },
    });

    expect(isOutgoingRingingCall(event!)).toBe(true);
    expect(isEndedCall(event!)).toBe(false);
  });

  it("keeps a newly accepted status-0 outbound call pending", () => {
    const event = normalizeFaceTimeCallEvent({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "call-0",
        call_status: 0,
        is_outgoing: true,
        handle: { value: "owner@example.com" },
      },
    });

    expect(event).toBeDefined();
    expect(isOutgoingRingingCall(event!)).toBe(true);
    expect(isEndedCall(event!)).toBe(false);
  });
});
