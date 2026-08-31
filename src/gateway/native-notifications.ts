import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { lazyCompile } from "../../packages/gateway-protocol/src/protocol-validator.js";
import {
  NativeNotificationMessageSchema,
  type NativeNotificationMessage,
  type NativeNotificationPreferences,
  type NotificationsPreferencesSetParams,
  type WebPushDevicePreferences,
} from "../../packages/gateway-protocol/src/schema/push.js";
import { USER_PREFS_VALUE_BYTES } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeDevicePublicKeyBase64Url } from "../infra/device-identity.js";
import { listPairedDevicesReadOnly } from "../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../infra/device-pairing.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  hasValidWebPushQuietHoursTimeZone,
  normalizeWebPushDevicePreferences,
  normalizeWebPushNotificationPreferences,
  resolveEffectiveWebPushPreferences,
} from "../infra/push-web-preferences.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import {
  resolveNotificationAuthority,
  type NotificationAuthority,
} from "./notification-authority.js";
import { READ_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export type { NativeNotificationMessage };
const NATIVE_NOTIFICATION_DEVICE_PREFERENCES_PREFIX = "notifications.native.v1.";
const MAX_NATIVE_NOTIFICATION_IDS = 256;
const validateMessage = lazyCompile(NativeNotificationMessageSchema);

export type NativeNotificationError = {
  code: "FORBIDDEN" | "INVALID_REQUEST";
  message: string;
};
type Operation<T> = Result<T, NativeNotificationError>;
type NativeNotificationShow = Extract<NativeNotificationMessage, { action: "show" }>;

type NativeNotificationTarget = {
  client: GatewayWsClient;
  visibilityClient: GatewayWsClient;
  preferences: NativeNotificationPreferences["effective"];
};

export interface NativeNotificationRegistry {
  subscribe(
    client: GatewayClient | null,
    enabled: boolean,
  ): Operation<NativeNotificationPreferences>;
  unsubscribe(client: GatewayClient | null): Operation<{ ok: true }>;
  unregister(client: GatewayClient | null): void;
  preferences(client: GatewayClient | null): Operation<NativeNotificationPreferences>;
  setPreferences(
    client: GatewayClient | null,
    params: NotificationsPreferencesSetParams,
  ): Operation<NativeNotificationPreferences>;
  test(client: GatewayClient | null): Operation<{ ok: true }>;
  targets(
    requiredScopes: readonly string[],
    onlyClient?: GatewayClient,
  ): NativeNotificationTarget[];
  send(target: NativeNotificationTarget, message: NativeNotificationShow): boolean;
  remove(id: string): void;
  clear(): void;
}

type Registration = {
  client: GatewayWsClient;
  deviceId: string;
  userProfileId: string | null;
  enabled: boolean;
  device: WebPushDevicePreferences;
  shown: Map<string, number>;
};

/** Native capabilities and their notification leases belong to exact authenticated sockets. */
export function createNativeNotificationRegistry(params: {
  clients: ReadonlySet<GatewayWsClient>;
  getRuntimeConfig: () => OpenClawConfig;
  send: (client: GatewayWsClient, message: NativeNotificationMessage) => void;
  onSubscribe?: (client: GatewayWsClient) => void;
  onPreferencesChanged?: (profileId: string, keys: string[]) => void;
  createTestNotification: (client: GatewayWsClient) => NativeNotificationShow;
  stateDir?: string;
}): NativeNotificationRegistry {
  const registrations = new Map<GatewayClient, Registration>();
  const targetOwners = new WeakMap<
    NativeNotificationTarget,
    { registration: Registration; scopes: readonly string[] }
  >();
  const databaseOptions = params.stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
    : {};
  const pairedDevices = () =>
    new Map(listPairedDevicesReadOnly(params.stateDir).map((device) => [device.deviceId, device]));
  const physicallyCurrent = (client: GatewayWsClient) =>
    params.clients.has(client) && client.socket.readyState === 1;
  const emit = (registration: Registration, message: NativeNotificationMessage): boolean => {
    if (!physicallyCurrent(registration.client)) {
      return false;
    }
    try {
      params.send(registration.client, message);
      return (
        registrations.get(registration.client) === registration &&
        physicallyCurrent(registration.client) &&
        !registration.client.invalidated
      );
    } catch {
      return false;
    }
  };
  const retire = (registration: Registration, clearShown: boolean) => {
    if (registrations.get(registration.client) !== registration) {
      return;
    }
    if (clearShown) {
      for (const id of registration.shown.keys()) {
        emit(registration, { action: "remove", id });
      }
    }
    registration.shown.clear();
    registrations.delete(registration.client);
  };
  const authorityFor = (client: GatewayWsClient, devices: Map<string, PairedDevice>) => {
    const device = client.connect.device;
    const paired = device ? devices.get(device.id) : undefined;
    if (
      !physicallyCurrent(client) ||
      client.invalidated ||
      (client.connect.role ?? "operator") !== "operator" ||
      !device ||
      !paired ||
      paired.publicKey !== normalizeDevicePublicKeyBase64Url(device.publicKey) ||
      (client.authenticatedGitHubIdentitySync && !client.authenticatedUserProfile)
    ) {
      return null;
    }
    return resolveNotificationAuthority({
      device: paired,
      userProfileId: client.authenticatedUserProfile?.profileId ?? null,
      cfg: params.getRuntimeConfig(),
      requiredScopes: [READ_SCOPE],
      connectionScopes: client.connect.scopes ?? [],
    });
  };
  const currentAuthority = (registration: Registration, devices = pairedDevices()) => {
    if (registrations.get(registration.client) !== registration) {
      return null;
    }
    const authority = authorityFor(registration.client, devices);
    const profileId = registration.userProfileId
      ? resolveUserProfileId(registration.userProfileId)
      : null;
    if (
      !authority ||
      registration.client.connect.device?.id !== registration.deviceId ||
      (registration.userProfileId && !profileId) ||
      authority.userProfileId !== profileId
    ) {
      retire(registration, true);
      return null;
    }
    return authority;
  };
  const allows = (authority: NotificationAuthority, scopes: readonly string[]) =>
    roleScopesAllow({ role: "operator", requestedScopes: scopes, allowedScopes: authority.scopes });
  const requireRegistration = (
    client: GatewayClient | null,
    scopes: readonly string[] = [READ_SCOPE],
  ): Operation<{ registration: Registration; authority: NotificationAuthority }> => {
    const registration = client ? registrations.get(client) : undefined;
    if (!registration) {
      return err({
        code: "INVALID_REQUEST",
        message:
          "Native notifications are not registered on this connection; subscribe again after reconnecting.",
      });
    }
    const authority = currentAuthority(registration);
    return authority && allows(authority, scopes)
      ? ok({ registration, authority })
      : err({
          code: "FORBIDDEN",
          message: "Current paired operator authority is required for native notifications.",
        });
  };
  const readPreferences = (
    registration: Registration,
    authority: NotificationAuthority,
  ): NativeNotificationPreferences => {
    const key = NATIVE_NOTIFICATION_DEVICE_PREFERENCES_PREFIX + registration.deviceId;
    const stored = authority.userProfileId
      ? getUserPreferences(
          authority.userProfileId,
          [WEB_PUSH_USER_PREFERENCES_KEY, key],
          databaseOptions,
        )
      : {};
    const user = normalizeWebPushNotificationPreferences(stored[WEB_PUSH_USER_PREFERENCES_KEY]);
    const device = authority.userProfileId
      ? normalizeWebPushDevicePreferences(stored[key])
      : registration.device;
    return {
      user,
      device,
      effective: resolveEffectiveWebPushPreferences({ user, device }),
      canManageUserPreferences: Boolean(
        authority.userProfileId && allows(authority, [WRITE_SCOPE]),
      ),
      devicePersistence: authority.userProfileId ? "profile" : "session",
    };
  };

  const registry: NativeNotificationRegistry = {
    subscribe(candidate, enabled) {
      const client = [...params.clients].find((connected) => connected === candidate);
      const deviceId = client?.connect.device?.id;
      const authority = client ? authorityFor(client, pairedDevices()) : null;
      const previous = candidate ? registrations.get(candidate) : undefined;
      if (!client || !authority || !deviceId) {
        if (previous) {
          retire(previous, true);
        }
        return err({
          code: "FORBIDDEN",
          message: "Native notifications require a live signed, paired operator connection.",
        });
      }
      const device =
        previous && currentAuthority(previous)
          ? previous.device
          : normalizeWebPushDevicePreferences(undefined);
      if (previous) {
        retire(previous, true);
      }
      const registration: Registration = {
        client,
        deviceId,
        userProfileId: authority.userProfileId,
        enabled,
        device,
        shown: new Map(),
      };
      registrations.set(client, registration);
      const preferences = readPreferences(registration, authority);
      params.onSubscribe?.(client);
      return ok(preferences);
    },
    unsubscribe(client) {
      const current = requireRegistration(client);
      if (!current.ok) {
        return current;
      }
      retire(current.value.registration, true);
      return ok({ ok: true });
    },
    unregister(client) {
      const registration = client ? registrations.get(client) : undefined;
      if (registration) {
        retire(registration, false);
      }
    },
    preferences(client) {
      const current = requireRegistration(client);
      return current.ok
        ? ok(readPreferences(current.value.registration, current.value.authority))
        : current;
    },
    setPreferences(client, input) {
      const current = requireRegistration(client, [WRITE_SCOPE]);
      if (!current.ok) {
        return current;
      }
      if (!hasValidWebPushQuietHoursTimeZone(input.preferences)) {
        return err({
          code: "INVALID_REQUEST",
          message: "Invalid notification quiet-hours time zone.",
        });
      }
      const { registration, authority } = current.value;
      if (input.scope === "user" && !authority.userProfileId) {
        return err({
          code: "INVALID_REQUEST",
          message:
            "User defaults require a durable authenticated profile; choose device preferences for this connection.",
        });
      }
      const preferences =
        input.scope === "user"
          ? normalizeWebPushNotificationPreferences(input.preferences)
          : normalizeWebPushDevicePreferences(input.preferences);
      const key =
        input.scope === "user"
          ? WEB_PUSH_USER_PREFERENCES_KEY
          : NATIVE_NOTIFICATION_DEVICE_PREFERENCES_PREFIX + registration.deviceId;
      if (authority.userProfileId) {
        const saved = setUserPreferences(
          authority.userProfileId,
          { [key]: preferences },
          databaseOptions,
        );
        if (!saved.ok) {
          return err({
            code: "INVALID_REQUEST",
            message: `Could not save notification preferences: ${saved.error.code}. Reduce the preference value or remove unused user preference keys.`,
          });
        }
        params.onPreferencesChanged?.(authority.userProfileId, [key]);
      } else {
        if (Buffer.byteLength(JSON.stringify(preferences), "utf8") > USER_PREFS_VALUE_BYTES) {
          return err({
            code: "INVALID_REQUEST",
            message: `Notification device preferences exceed the ${USER_PREFS_VALUE_BYTES}-byte preference limit.`,
          });
        }
        registration.device = normalizeWebPushDevicePreferences(preferences);
      }
      return ok(readPreferences(registration, authority));
    },
    targets(requiredScopes, onlyClient) {
      if (registrations.size === 0) {
        return [];
      }
      const devices = pairedDevices();
      const targets: NativeNotificationTarget[] = [];
      for (const registration of registrations.values()) {
        if (onlyClient && registration.client !== onlyClient) {
          continue;
        }
        const authority = currentAuthority(registration, devices);
        if (!authority || !registration.enabled || !allows(authority, requiredScopes)) {
          continue;
        }
        const target: NativeNotificationTarget = {
          client: registration.client,
          visibilityClient: {
            ...registration.client,
            connect: { ...registration.client.connect, scopes: authority.scopes },
            ...(registration.client.authenticatedUserProfile && authority.userProfileId
              ? {
                  authenticatedUserProfile: {
                    ...registration.client.authenticatedUserProfile,
                    profileId: authority.userProfileId,
                  },
                }
              : {}),
          },
          preferences: readPreferences(registration, authority).effective,
        };
        targetOwners.set(target, { registration, scopes: [...requiredScopes] });
        targets.push(target);
      }
      return targets;
    },
    send(target, message) {
      const owner = targetOwners.get(target);
      if (!owner || message.action !== "show" || !validateMessage(message)) {
        return false;
      }
      const { registration, scopes } = owner;
      const authority = currentAuthority(registration);
      if (!authority || !registration.enabled || !allows(authority, scopes)) {
        return false;
      }
      const now = Date.now();
      if (message.expiresAtMs <= now) {
        return false;
      }
      for (const [id, expiry] of registration.shown) {
        if (
          expiry <= now ||
          (registration.shown.size >= MAX_NATIVE_NOTIFICATION_IDS &&
            !registration.shown.has(message.id))
        ) {
          emit(registration, { action: "remove", id });
          registration.shown.delete(id);
        }
      }
      if (!emit(registration, message)) {
        return false;
      }
      // Cleanup/replay owns only IDs actually handed to this exact live registration.
      registration.shown.delete(message.id);
      registration.shown.set(message.id, message.expiresAtMs);
      return true;
    },
    remove(id) {
      if (registrations.size === 0) {
        return;
      }
      const devices = pairedDevices();
      for (const registration of registrations.values()) {
        if (!currentAuthority(registration, devices) || !registration.shown.delete(id)) {
          continue;
        }
        emit(registration, { action: "remove", id });
      }
    },
    test(client) {
      const current = requireRegistration(client);
      if (!current.ok) {
        return current;
      }
      const target = registry.targets([READ_SCOPE], current.value.registration.client)[0];
      return target && registry.send(target, params.createTestNotification(target.client))
        ? ok({ ok: true })
        : err({
            code: "INVALID_REQUEST",
            message:
              "Native notifications are unavailable; enable operating-system notification permission and subscribe again.",
          });
    },
    clear() {
      for (const registration of registrations.values()) {
        retire(registration, true);
      }
    },
  };
  return registry;
}
