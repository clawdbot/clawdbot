import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  issueDeviceBootstrapToken,
  issueDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion,
  verifyDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import { persistDevicePairingStoreState } from "../../../infra/device-pairing-store.js";
import type { PairedDevice } from "../../../infra/device-pairing.types.js";
import { PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../../shared/device-bootstrap-profile.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));

vi.mock("../../../state/user-profiles.js", () => ({
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  listProfiles: vi.fn(() => []),
}));

vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiPluginTabs: vi.fn(() => []),
  listControlUiPluginWidgetKinds: vi.fn(() => []),
}));

vi.mock("./connect-auth-security.js", () => ({
  emitGatewayAuthSecurityEvent: vi.fn(),
}));

import { sendGatewayHello } from "./connect-hello.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendGatewayHello setup completion ordering", () => {
  it.each([false, true])(
    "persists setup status before presence publication (failure=%s)",
    async (presenceFails) => {
      await withOpenClawTestState(
        { label: "ws-setup-completion-order", layout: "state-only" },
        async () => {
          const paired: PairedDevice = {
            deviceId: "device-setup-order",
            publicKey: "public-key-setup-order",
            displayName: "Test phone",
            createdAtMs: 1,
            approvedAtMs: 2,
          };
          persistDevicePairingStoreState(
            { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
            undefined,
            "paired",
          );
          const issued = await issueDevicePairSetupBootstrapToken({
            profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          });
          await expect(
            verifyDeviceBootstrapToken({
              token: issued.token,
              deviceId: paired.deviceId,
              publicKey: paired.publicKey,
              role: "operator",
              scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
            }),
          ).resolves.toEqual({ ok: true });

          const handoffStarted = createDeferred();
          const releaseHandoff = createDeferred();
          const broadcast = vi.fn((event: string) => {
            if (presenceFails && event === "presence") {
              throw new Error("test presence publication failure");
            }
          });
          const context = {
            handler: {
              getClient: () => ({ presenceKey: "conn-setup-order", socket: { readyState: 1 } }),
              isClosed: () => false,
              connId: "conn-setup-order",
              gatewayMethods: [],
              events: [],
              buildRequestContext: () => ({
                broadcast,
                incrementPresenceVersion: () => 2,
                getHealthVersion: () => 1,
                nodeRegistry: { get: () => undefined },
              }),
              refreshHealthSnapshot: vi.fn(async () => ({})),
              close: vi.fn(),
              advanceHandshakePhase: vi.fn(),
              setCloseCause: vi.fn(),
              logGateway: { warn: vi.fn() },
              logHealth: { error: vi.fn() },
            },
            frame: { id: "hello-setup-order" },
            connectParams: {
              client: {
                id: "openclaw-ios",
                version: "dev",
                platform: "test",
                mode: "backend",
              },
              role: "operator",
              scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
            },
            configSnapshot: {},
            sendFrame: vi.fn(async () => {
              handoffStarted.resolve();
              await releaseHandoff.promise;
            }),
            pendingNodePairingCleanup: {},
            releasePendingNodePairingCleanup: vi.fn(async () => undefined),
          };
          const state = {
            resolvedAuth: { mode: "none" },
            role: "operator",
            scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
            device: { id: paired.deviceId },
            devicePublicKey: paired.publicKey,
            hasTokenAuth: false,
            hasPasswordAuth: false,
            bootstrapTokenCandidate: issued.token,
            authResult: { ok: true, method: "bootstrap-token" },
            authMethod: "bootstrap-token",
            issuedBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
            handoffBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
            deviceToken: null,
            bootstrapDeviceTokens: [],
          };

          const hello = sendGatewayHello(context as never, state as never, {});
          await handoffStarted.promise;
          const completionAtHandoff = await readDevicePairSetupCompletion({
            setupId: issued.setupId,
          });
          releaseHandoff.resolve();
          if (presenceFails) {
            await expect(hello).rejects.toThrow("test presence publication failure");
          } else {
            await hello;
          }
          const completionAfterHandoff = await readDevicePairSetupCompletion({
            setupId: issued.setupId,
          });

          expect(completionAtHandoff).toMatchObject({
            setupId: issued.setupId,
            deviceId: paired.deviceId,
            deviceName: paired.displayName,
            access: "limited",
            deliveryState: "uncertain",
          });
          expect(completionAfterHandoff).toMatchObject({ deliveryState: "confirmed" });
          expect(broadcast).toHaveBeenCalledWith(
            "device.pair.setup.completed",
            expect.objectContaining({ setupId: issued.setupId }),
            { dropIfSlow: true },
          );
          const publications = broadcast.mock.calls.map(([event]) => event);
          expect(publications.indexOf("device.pair.setup.completed")).toBeLessThan(
            publications.indexOf("presence"),
          );
        },
      );
    },
  );

  it("keeps correlated setup completion uncertain when hello delivery fails", async () => {
    await withOpenClawTestState(
      { label: "ws-setup-completion-send-failure", layout: "state-only" },
      async () => {
        const paired: PairedDevice = {
          deviceId: "device-setup-send-failure",
          publicKey: "public-key-setup-send-failure",
          displayName: "Test phone",
          createdAtMs: 1,
          approvedAtMs: 2,
        };
        persistDevicePairingStoreState(
          { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
          undefined,
          "paired",
        );
        const issued = await issueDevicePairSetupBootstrapToken({
          profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        const verifyParams = {
          token: issued.token,
          deviceId: paired.deviceId,
          publicKey: paired.publicKey,
          role: "operator" as const,
          scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
        };
        await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({ ok: true });

        const broadcast = vi.fn();
        const close = vi.fn();
        const context = {
          handler: {
            getClient: () => null,
            connId: "conn-setup-send-failure",
            gatewayMethods: [],
            events: [],
            buildRequestContext: () => ({ broadcast, nodeRegistry: { get: vi.fn() } }),
            refreshHealthSnapshot: vi.fn(async () => ({})),
            close,
            advanceHandshakePhase: vi.fn(),
            setCloseCause: vi.fn(),
            logGateway: { warn: vi.fn() },
            logHealth: { error: vi.fn() },
          },
          frame: { id: "hello-setup-send-failure" },
          connectParams: {
            client: { id: "openclaw-ios", version: "dev", platform: "test", mode: "backend" },
            role: "operator",
            scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          },
          configSnapshot: {},
          sendFrame: vi.fn(async () => {
            throw new Error("socket closed");
          }),
          pendingNodePairingCleanup: {},
          releasePendingNodePairingCleanup: vi.fn(async () => undefined),
        };
        const state = {
          resolvedAuth: { mode: "none" },
          role: "operator",
          scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          device: { id: paired.deviceId },
          devicePublicKey: paired.publicKey,
          hasTokenAuth: false,
          hasPasswordAuth: false,
          bootstrapTokenCandidate: issued.token,
          authResult: { ok: true, method: "bootstrap-token" },
          authMethod: "bootstrap-token",
          issuedBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          handoffBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          deviceToken: null,
          bootstrapDeviceTokens: [],
        };

        await sendGatewayHello(context as never, state as never, {});

        expect(close).toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith(
          "device.pair.setup.deliveryUncertain",
          expect.objectContaining({ setupId: issued.setupId, deviceId: paired.deviceId }),
          { dropIfSlow: true },
        );
        expect(
          broadcast.mock.calls.some(([event]) => event === "device.pair.setup.completed"),
        ).toBe(false);
        await expect(
          readDevicePairSetupCompletion({ setupId: issued.setupId }),
        ).resolves.toMatchObject({
          setupId: issued.setupId,
          deviceId: paired.deviceId,
          deliveryState: "uncertain",
        });
        await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({
          ok: false,
          reason: "bootstrap_token_invalid",
        });
      },
    );
  });

  it("does not consume a setup bearer after the paired public key is replaced", async () => {
    await withOpenClawTestState(
      { label: "ws-setup-completion-replaced-key", layout: "state-only" },
      async () => {
        const paired: PairedDevice = {
          deviceId: "device-setup-replaced",
          publicKey: "public-key-original",
          createdAtMs: 1,
          approvedAtMs: 2,
        };
        persistDevicePairingStoreState(
          { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
          undefined,
          "paired",
        );
        const issued = await issueDevicePairSetupBootstrapToken({
          profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        await expect(
          verifyDeviceBootstrapToken({
            token: issued.token,
            deviceId: paired.deviceId,
            publicKey: paired.publicKey,
            role: "operator",
            scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          }),
        ).resolves.toEqual({ ok: true });
        persistDevicePairingStoreState(
          {
            pendingById: {},
            pairedByDeviceId: {
              [paired.deviceId]: { ...paired, publicKey: "public-key-replacement" },
            },
          },
          undefined,
          "paired",
        );
        const close = vi.fn();
        const context = {
          handler: {
            getClient: () => null,
            connId: "conn-setup-replaced",
            gatewayMethods: [],
            events: [],
            buildRequestContext: () => ({ broadcast: vi.fn(), nodeRegistry: { get: vi.fn() } }),
            refreshHealthSnapshot: vi.fn(async () => ({})),
            close,
            advanceHandshakePhase: vi.fn(),
            setCloseCause: vi.fn(),
            logGateway: { warn: vi.fn() },
            logHealth: { error: vi.fn() },
          },
          frame: { id: "hello-setup-replaced" },
          connectParams: {
            client: { id: "openclaw-ios", version: "dev", platform: "test", mode: "backend" },
            role: "operator",
            scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          },
          configSnapshot: {},
          sendFrame: vi.fn(async () => undefined),
          pendingNodePairingCleanup: {},
          releasePendingNodePairingCleanup: vi.fn(async () => undefined),
        };
        const state = {
          resolvedAuth: { mode: "none" },
          role: "operator",
          scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          device: { id: paired.deviceId },
          devicePublicKey: paired.publicKey,
          hasTokenAuth: false,
          hasPasswordAuth: false,
          bootstrapTokenCandidate: issued.token,
          authResult: { ok: true, method: "bootstrap-token" },
          authMethod: "bootstrap-token",
          issuedBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          handoffBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          deviceToken: null,
          bootstrapDeviceTokens: [],
        };

        await sendGatewayHello(context as never, state as never, {});

        expect(close).toHaveBeenCalled();
        expect(context.sendFrame).not.toHaveBeenCalled();
        await expect(
          readDevicePairSetupCompletion({ setupId: issued.setupId }),
        ).resolves.toBeNull();
        await expect(
          verifyDeviceBootstrapToken({
            token: issued.token,
            deviceId: paired.deviceId,
            publicKey: paired.publicKey,
            role: "operator",
            scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          }),
        ).resolves.toEqual({ ok: true });
      },
    );
  });

  it("restores an uncorrelated bootstrap token when hello delivery fails", async () => {
    await withOpenClawTestState(
      { label: "ws-generic-bootstrap-send-failure", layout: "state-only" },
      async () => {
        const paired: PairedDevice = {
          deviceId: "device-generic-send-failure",
          publicKey: "public-key-generic-send-failure",
          createdAtMs: 1,
          approvedAtMs: 2,
        };
        persistDevicePairingStoreState(
          { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
          undefined,
          "paired",
        );
        const issued = await issueDeviceBootstrapToken({
          profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        const verifyParams = {
          token: issued.token,
          deviceId: paired.deviceId,
          publicKey: paired.publicKey,
          role: "operator",
          scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
        };
        await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({ ok: true });

        const close = vi.fn();
        const context = {
          handler: {
            getClient: () => null,
            connId: "conn-generic-send-failure",
            gatewayMethods: [],
            events: [],
            buildRequestContext: () => ({ broadcast: vi.fn(), nodeRegistry: { get: vi.fn() } }),
            refreshHealthSnapshot: vi.fn(async () => ({})),
            close,
            advanceHandshakePhase: vi.fn(),
            setCloseCause: vi.fn(),
            logGateway: { warn: vi.fn() },
            logHealth: { error: vi.fn() },
          },
          frame: { id: "hello-generic-send-failure" },
          connectParams: {
            client: { id: "openclaw-ios", version: "dev", platform: "test", mode: "backend" },
            role: "operator",
            scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          },
          configSnapshot: {},
          sendFrame: vi.fn(async () => {
            throw new Error("socket closed");
          }),
          pendingNodePairingCleanup: {},
          releasePendingNodePairingCleanup: vi.fn(async () => undefined),
        };
        const state = {
          resolvedAuth: { mode: "none" },
          role: "operator",
          scopes: PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes,
          device: { id: paired.deviceId },
          devicePublicKey: paired.publicKey,
          hasTokenAuth: false,
          hasPasswordAuth: false,
          bootstrapTokenCandidate: issued.token,
          authResult: { ok: true, method: "bootstrap-token" },
          authMethod: "bootstrap-token",
          issuedBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          handoffBootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          deviceToken: null,
          bootstrapDeviceTokens: [],
        };

        await sendGatewayHello(context as never, state as never, {});

        expect(close).toHaveBeenCalled();
        await expect(verifyDeviceBootstrapToken(verifyParams)).resolves.toEqual({ ok: true });
      },
    );
  });
});
