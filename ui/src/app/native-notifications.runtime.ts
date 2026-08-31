import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { NativeNotificationPreferencesSchema } from "../../../packages/gateway-protocol/src/schema/push.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  NATIVE_BRIDGE_UPDATE_MESSAGE,
  NATIVE_NOTIFICATIONS_STATUS_EVENT,
} from "./native-notifications.ts";
import type { NotificationAction, NotificationsCapability } from "./notifications.ts";

const NativeNotificationsStatusSchema = Type.Object({
  supported: Type.Boolean(),
  permission: Type.Union([
    Type.Literal("granted"),
    Type.Literal("denied"),
    Type.Literal("notDetermined"),
    Type.Literal("unknown"),
  ]),
  replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  test: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({ state: Type.Literal("pending") }),
      Type.Object({ state: Type.Literal("sent") }),
      Type.Object({ state: Type.Literal("error"), message: Type.String() }),
    ]),
  ),
  preferences: Type.Optional(Type.Union([Type.Null(), NativeNotificationPreferencesSchema])),
});

// Shared with the native dashboard bridges. Targets and notification content
// are captured by native owners, never supplied by this embedded document.
type NativeNotificationsStatus = Static<typeof NativeNotificationsStatusSchema>;
export type NativeNotificationsPermission = NativeNotificationsStatus["permission"];
export type NativeNotificationsSnapshot = NativeNotificationsStatus & {
  kind: "native";
  loading: boolean;
};
type NativeNotificationsCommand =
  | { type: "status" | "request-permission" | "send-test" | "preferences-get" }
  | ({ type: "preferences-set" } & Omit<Extract<NotificationAction, { kind: "set" }>, "kind">);
type NativeNotificationsMessage = NativeNotificationsCommand & { requestId: string };

let capabilitySequence = 0;

export type NativeNotificationsRuntime = Pick<NotificationsCapability, "run" | "dispose">;

type NativeNotificationsOperation = {
  request: NativeNotificationsMessage;
  promise: Promise<void>;
  resolve(): void;
};

function snapshotFrom(value: unknown): NativeNotificationsStatus | null {
  return Value.Check(NativeNotificationsStatusSchema, value) ? value : null;
}

export function createNativeNotificationsRuntime(params: {
  initial: unknown;
  post: (message: NativeNotificationsMessage) => void;
  publish(snapshot: NativeNotificationsSnapshot): void;
}): NativeNotificationsRuntime {
  const { initial, post } = params;
  let snapshot: NativeNotificationsSnapshot = {
    ...(snapshotFrom(initial) ?? {
      supported: false,
      permission: "unknown",
      error: initial === undefined ? null : NATIVE_BRIDGE_UPDATE_MESSAGE,
    }),
    kind: "native",
    loading: false,
  };
  const capabilityId = ++capabilitySequence;
  let requestSequence = 0;
  let disposed = false;
  let operation: NativeNotificationsOperation | null = null;
  const nextRequestId = () => `notifications-${capabilityId}-${++requestSequence}`;
  const publish = (next: NativeNotificationsSnapshot) => {
    snapshot = next;
    params.publish(snapshot);
  };
  const postOperation = (pending: NativeNotificationsOperation) => {
    if (disposed || operation !== pending) {
      return;
    }
    try {
      post(pending.request);
    } catch (error) {
      if (operation !== pending) {
        return;
      }
      operation = null;
      pending.resolve();
      const message = formatUiError(error);
      publish({
        ...snapshot,
        loading: false,
        error: message,
        ...(pending.request.type === "send-test"
          ? { test: { state: "error" as const, message } }
          : {}),
      });
    }
  };
  const handleStatus = (event: Event) => {
    // SAFETY: Native bridges dispatch CustomEvent; snapshotFrom validates its unknown detail.
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (!next) {
      publish({
        kind: "native",
        supported: false,
        permission: snapshot.permission,
        loading: snapshot.loading,
        error: NATIVE_BRIDGE_UPDATE_MESSAGE,
      });
      return;
    }
    // Focus/status refreshes and incoming native events cannot acknowledge a
    // different in-flight preference or permission request.
    const pending = operation;
    if (pending && next.replyTo === pending.request.requestId) {
      if (
        pending.request.type === "request-permission" &&
        next.supported &&
        next.permission === "granted" &&
        !next.error &&
        next.preferences?.device.enabled === false
      ) {
        // Enable owns both permission and this device's mute setting. Native
        // adapters supply current preferences; keep their other overrides intact.
        pending.request = {
          type: "preferences-set",
          requestId: nextRequestId(),
          scope: "device",
          preferences: { ...next.preferences.device, enabled: true },
        };
        publish({ ...next, kind: "native", loading: true });
        postOperation(pending);
        return;
      }
      pending.resolve();
      operation = null;
    }
    publish({ ...next, kind: "native", loading: operation !== null });
  };
  const refreshStatus = () => {
    try {
      post({ type: "status", requestId: nextRequestId() });
    } catch (error) {
      publish({ ...snapshot, error: formatUiError(error) });
    }
  };

  window.addEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus);
  window.addEventListener("focus", refreshStatus);
  publish(snapshot);
  refreshStatus();

  return {
    run(action) {
      if (disposed) {
        return Promise.resolve();
      }
      if (!snapshot.supported) {
        publish({ ...snapshot, error: snapshot.error ?? NATIVE_BRIDGE_UPDATE_MESSAGE });
        return Promise.resolve();
      }
      if (operation) {
        return operation.promise;
      }
      let message: NativeNotificationsCommand;
      switch (action.kind) {
        case "enable":
          message = { type: "request-permission" };
          break;
        case "test":
          message = { type: "send-test" };
          break;
        case "disable":
          if (!snapshot.preferences) {
            return Promise.resolve();
          }
          message = {
            type: "preferences-set",
            scope: "device",
            preferences: { ...snapshot.preferences.device, enabled: false },
          };
          break;
        case "set":
          message = {
            type: "preferences-set",
            scope: action.scope,
            preferences: action.preferences,
          };
          break;
      }
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const pending = { request: { ...message, requestId: nextRequestId() }, promise, resolve };
      operation = pending;
      publish({
        ...snapshot,
        loading: true,
        error: null,
        ...(action.kind === "test" ? { test: { state: "pending" as const } } : {}),
      });
      postOperation(pending);
      return promise;
    },
    dispose() {
      disposed = true;
      operation?.resolve();
      operation = null;
      window.removeEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus);
      window.removeEventListener("focus", refreshStatus);
    },
  };
}
