import type { ConnectParams, HelloOk } from "@openclaw/gateway-protocol";
import {
  buildGatewayConnectAuth,
  resolveGatewayConnectScopes,
  selectGatewayConnectAuth,
} from "./connect-auth.js";
import type { GatewayConnectAuthSelection } from "./connect-auth.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";

export type GatewayBrowserDeviceIdentity = {
  deviceId: string;
  publicKey: string;
  sign: (payload: string) => Promise<string>;
};

export type GatewayBrowserDeviceTokenRecord = {
  token: string;
  scopes: string[];
};

type MaybePromise<T> = T | Promise<T>;

export type GatewayBrowserDeviceTokenStore = {
  load: (params: {
    clientId: string;
    deviceId: string;
    role: string;
  }) => MaybePromise<GatewayBrowserDeviceTokenRecord | null>;
  store: (params: {
    clientId: string;
    deviceId: string;
    role: string;
    token: string;
    scopes: string[];
  }) => MaybePromise<void>;
  clear: (params: { clientId: string; deviceId: string; role: string }) => MaybePromise<void>;
};

export type GatewayBrowserDeviceAuthPlan = {
  clientId: string;
  role: string;
  identity: GatewayBrowserDeviceIdentity | null;
  selectedAuth: GatewayConnectAuthSelection;
  scopes: string[];
  device?: NonNullable<ConnectParams["device"]>;
  auth?: ConnectParams["auth"];
};

/** Browser-safe device pairing and issued-token lifecycle shared by first-party UI clients. */
export class GatewayBrowserDeviceAuthLifecycle {
  constructor(
    private readonly deps: {
      loadIdentity: () => Promise<GatewayBrowserDeviceIdentity | null>;
      tokenStore: GatewayBrowserDeviceTokenStore;
      nowMs?: () => number;
    },
  ) {}

  async buildPlan(params: {
    client: ConnectParams["client"];
    role: string;
    defaultScopes: readonly string[];
    bootstrapScopes?: readonly string[];
    token?: string;
    bootstrapToken?: string;
    password?: string;
    pendingDeviceTokenRetry?: boolean;
    trustedDeviceTokenRetry?: boolean;
    preferBootstrapToken?: boolean;
    nonce: string | null;
  }): Promise<GatewayBrowserDeviceAuthPlan> {
    const identity = await this.deps.loadIdentity();
    const stored = identity
      ? await this.deps.tokenStore.load({
          clientId: params.client.id,
          deviceId: identity.deviceId,
          role: params.role,
        })
      : null;
    const storedValue = stored?.token;
    const selectedAuth = selectGatewayConnectAuth({
      token: params.token,
      bootstrapToken: params.bootstrapToken,
      password: params.password,
      storedToken: storedValue,
      storedScopes: stored?.scopes,
      pendingDeviceTokenRetry: params.pendingDeviceTokenRetry,
      trustedDeviceTokenRetry: params.trustedDeviceTokenRetry,
      preferBootstrapToken: params.preferBootstrapToken,
    });
    const { usingStoredDeviceToken } = selectedAuth;
    const scopes = resolveGatewayConnectScopes({
      requestedScopes: selectedAuth.authBootstrapToken
        ? params.bootstrapScopes
          ? [...params.bootstrapScopes]
          : undefined
        : undefined,
      usingStoredDeviceToken,
      storedScopes: selectedAuth.storedScopes,
      defaultScopes: params.defaultScopes,
    });
    if (!identity) {
      return {
        clientId: params.client.id,
        role: params.role,
        identity,
        selectedAuth,
        scopes,
        auth: buildGatewayConnectAuth(selectedAuth),
      };
    }
    const signedAtMs = this.deps.nowMs?.() ?? Date.now();
    const nonce = params.nonce ?? "";
    const { authBootstrapToken: primary, signatureToken: signed } = selectedAuth;
    let token: string | null = null;
    if (primary) {
      token = primary;
    } else if (signed) {
      token = signed;
    }
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: params.client.id,
      clientMode: params.client.mode,
      role: params.role,
      scopes,
      signedAtMs,
      token,
      nonce,
      platform: params.client.platform,
      deviceFamily: params.client.deviceFamily,
    });
    return {
      clientId: params.client.id,
      role: params.role,
      identity,
      selectedAuth,
      scopes,
      auth: buildGatewayConnectAuth(selectedAuth),
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signature: await identity.sign(payload),
        signedAt: signedAtMs,
        nonce,
      },
    };
  }

  async acceptHello(
    hello: Pick<HelloOk, "auth">,
    plan: GatewayBrowserDeviceAuthPlan,
  ): Promise<void> {
    const token = hello.auth?.deviceToken?.trim();
    if (!token || !plan.identity) {
      return;
    }
    await this.deps.tokenStore.store({
      clientId: plan.clientId,
      deviceId: plan.identity.deviceId,
      role: hello.auth?.role ?? plan.role,
      token,
      scopes: hello.auth?.scopes ?? [],
    });
  }

  async clearStoredToken(plan: GatewayBrowserDeviceAuthPlan): Promise<void> {
    if (!plan.identity) {
      return;
    }
    await this.deps.tokenStore.clear({
      clientId: plan.clientId,
      deviceId: plan.identity.deviceId,
      role: plan.role,
    });
  }
}
