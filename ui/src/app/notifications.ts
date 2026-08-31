import type {
  NativeNotificationPreferences,
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../packages/gateway-protocol/src/schema/push.ts";
import type { ApplicationGateway } from "./gateway.ts";
import {
  createNativeNotificationsCapability,
  type NativeNotificationsSnapshot,
} from "./native-notifications.ts";
import { createWebPushCapability, type WebPushSnapshot } from "./web-push.ts";

export type NotificationPreferences = Omit<NativeNotificationPreferences, "devicePersistence"> & {
  devicePersistence: "profile" | "session" | "browser";
};

export type NotificationAction =
  | { kind: "enable" | "disable" | "test" }
  | { kind: "set"; scope: "user"; preferences: WebPushNotificationPreferences }
  | { kind: "set"; scope: "device"; preferences: WebPushDevicePreferences };

export type NotificationsSnapshot = NativeNotificationsSnapshot | WebPushSnapshot;

export type NotificationsCapability = {
  readonly snapshot: NotificationsSnapshot;
  subscribe(listener: () => void): () => void;
  run(action: NotificationAction): Promise<void>;
  dispose(): void;
};

export function createNotificationsCapability(
  gateway: ApplicationGateway,
): NotificationsCapability {
  // A native bridge owns delivery even when its Gateway is unavailable. Creating
  // Web Push as well would register a second transport for the embedded dashboard.
  return createNativeNotificationsCapability() ?? createWebPushCapability(gateway);
}
