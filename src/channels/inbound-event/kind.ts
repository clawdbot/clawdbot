/**
 * High-level inbound event class used to separate actionable user requests from room activity.
 */
export type InboundEventKind = "user_request" | "room_event";
