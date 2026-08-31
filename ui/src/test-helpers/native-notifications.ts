import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../packages/gateway-protocol/src/schema/push.ts";
import type { NativeNotificationsSnapshot } from "../app/native-notifications.ts";

export type NativeNotificationsStatus = Omit<NativeNotificationsSnapshot, "kind" | "loading">;

// The fixture models the messages accepted by both native hosts independently
// from the capability's private request implementation.
export type NativeNotificationsMessage = { requestId: string } & (
  | { type: "status" | "request-permission" | "send-test" | "preferences-get" }
  | { type: "preferences-set"; scope: "user"; preferences: WebPushNotificationPreferences }
  | { type: "preferences-set"; scope: "device"; preferences: WebPushDevicePreferences }
);
