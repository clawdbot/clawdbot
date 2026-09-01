// Regression cover for the Control UI HTTP read surfaces over Tailscale Serve.
//
// Verified tailnet identity buys nothing here. It is ambient — every request
// from this host carries it — so no Control UI read accepts it on its own, the
// bootstrap config read included: a browser presenting nothing else gets a 401
// off every one of them.
//
// Every read is principal-bound instead. Once the Control UI websocket connect
// authenticates, the Gateway hands the browser a credential whose issuance is
// device-gated — it is minted only after that connect's device proof verifies —
// and the bootstrap config, media metadata, ticket minting, and bytes all run
// off that credential or a real one. Redemption re-resolves the presenting
// request's own verified principal and requires managed Serve ingress; it does
// not re-check the device. So the credential does not travel between tailnet
// users, but another client acting as the same verified principal can present
// it until it expires.
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import { issueControlUiDeviceCredential } from "./control-ui-device-credential.js";
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { READ_SCOPE as CONTROL_UI_READ_SCOPE } from "./operator-scopes.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { testTailscaleWhois } from "./test-helpers.runtime-state.js";
import { makeMockHttpResponse } from "./test-http-response.js";

vi.mock("../infra/tailscale.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/tailscale.js")>("../infra/tailscale.js");
  return {
    ...actual,
    readTailscaleWhoisIdentity: async () => testTailscaleWhois.value,
  };
});

const testTempDirs = useAutoCleanupTempDirTracker(afterEach);

const TAILSCALE_AUTH: ResolvedGatewayAuth = {
  mode: "token",
  token: "shared-token",
  allowTailscale: true,
};

/**
 * The same resolved auth after an operator sets `gateway.auth.allowTailscale:
 * false`. Only the flag differs, so the shared secret — and therefore the
 * session generation credentials are stamped with — is untouched: nothing
 * rotates or revokes an outstanding credential on this flip, which is why
 * redemption has to consult the flag itself.
 */
const TAILSCALE_DISABLED_AUTH: ResolvedGatewayAuth = { ...TAILSCALE_AUTH, allowTailscale: false };

/** The tailnet user whose browser completed the connect that minted a credential. */
const DASHBOARD_PRINCIPAL = "peter@github";
/** A second tailnet user reaching the same managed Serve ingress. */
const OTHER_PRINCIPAL = "quinn@github";

/**
 * A same-origin dashboard fetch arriving through managed Tailscale Serve with no
 * shared secret and no paired device token. The transport marking is what the
 * Serve listener applies; without it the forwarded headers are unattributable,
 * so `managedServe: false` models the same headers replayed off that ingress.
 */
function tailscaleServeRequest(params: {
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  const headers = {
    host: "gateway.local",
    "x-forwarded-for": "100.64.0.1",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "ai-hub.bone-egret.ts.net",
    "tailscale-user-login": DASHBOARD_PRINCIPAL,
    "tailscale-user-name": "Peter",
    "sec-fetch-site": "same-origin",
    ...params.headers,
  };
  const req = {
    url: params.url,
    method: "GET",
    socket: { remoteAddress: "127.0.0.1", localPort: 18_789 },
    headers,
    headersDistinct: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, [String(value)]]),
    ),
  } as unknown as IncomingMessage;
  markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  return req;
}

/**
 * A same-origin request reaching the Gateway's own port instead of the managed
 * Serve listener — where a credential lifted off the dashboard would be replayed.
 * Carries no tailnet headers, so it attributes cleanly as a direct remote client
 * and any refusal is a real auth decision.
 */
function offServeIngressRequest(params: {
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  return {
    url: params.url,
    method: "GET",
    socket: { remoteAddress: "192.168.1.50", localPort: 18_789 },
    headers: {
      host: "gateway.local",
      "sec-fetch-site": "same-origin",
      ...params.headers,
    },
  } as unknown as IncomingMessage;
}

/** Tailnet-shaped headers set by a client that is not behind managed Serve. */
function spoofedTailscaleHeaderRequest(url: string): IncomingMessage {
  return offServeIngressRequest({
    url,
    headers: { "tailscale-user-login": "peter@github", "tailscale-user-name": "Peter" },
  });
}

/**
 * The credential the connect handshake hands a Serve dashboard once its
 * websocket authenticates. Minted through the production issuer so this proves
 * the HTTP side accepts exactly what hello-ok emits, for the tailnet principal
 * that connect authenticated as.
 */
function postConnectDeviceCredential(principal = DASHBOARD_PRINCIPAL): string {
  const issued = issueControlUiDeviceCredential({
    deviceId: "device-tailscale-serve-dashboard",
    principal,
    authGeneration: resolveSharedGatewaySessionGeneration(TAILSCALE_AUTH),
  });
  if (!issued) {
    throw new Error("expected a principal-bound Control UI credential");
  }
  return issued.credential;
}

/**
 * Longer than the shipped credential TTL, so `postConnectDeviceCredential`
 * minted this far back is certainly past its deadline now.
 */
const PAST_ANY_DEADLINE_MS = 13 * 60 * 60 * 1000;

/** The same credential, minted at an explicit point in time. */
function deviceCredentialIssuedAt(nowMs: number): string {
  const issued = issueControlUiDeviceCredential({
    deviceId: "device-tailscale-serve-dashboard",
    principal: DASHBOARD_PRINCIPAL,
    authGeneration: resolveSharedGatewaySessionGeneration(TAILSCALE_AUTH),
    nowMs,
  });
  if (!issued) {
    throw new Error("expected a principal-bound Control UI credential");
  }
  return issued.credential;
}

async function withAssistantMediaFile<T>(
  name: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const mediaDir = path.join(resolveStateDir(), "media", name);
  await fs.mkdir(mediaDir, { recursive: true });
  const filePath = path.join(
    mediaDir,
    `media-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  await fs.writeFile(filePath, "tailscale serve attachment\n", "utf8");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(mediaDir, { recursive: true, force: true });
  }
}

async function runAssistantMediaRequest(
  req: IncomingMessage,
  auth: ResolvedGatewayAuth = TAILSCALE_AUTH,
) {
  const { res, end, setHeader } = makeMockHttpResponse();
  const handled = await handleControlUiAssistantMediaRequest(req, res, { auth });
  return { res, end, setHeader, handled };
}

/**
 * A paired Control UI browser device holding an ordinary operator token, issued
 * under the same shared-gateway generation the Serve credential carries.
 */
async function withPairedControlUiDeviceToken<T>(fn: (operatorToken: string) => Promise<T>) {
  const tempHome = testTempDirs.make("openclaw-ts-scopes-device-");
  return await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
    const deviceId = "control-ui-paired-browser";
    const requested = await requestDevicePairing({
      deviceId,
      publicKey: "test-public-key",
      role: "operator",
      scopes: [CONTROL_UI_READ_SCOPE],
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
    });
    const approved = await approveDevicePairing(requested.request.requestId, {
      callerScopes: [CONTROL_UI_READ_SCOPE],
    });
    expect(approved?.status).toBe("approved");
    const issued = await ensureDeviceToken({
      deviceId,
      role: "operator",
      scopes: [CONTROL_UI_READ_SCOPE],
      issuer: {
        kind: "shared-gateway-auth",
        generation: resolveSharedGatewaySessionGeneration(TAILSCALE_AUTH) ?? "",
      },
    });
    expect(typeof issued?.token).toBe("string");
    return await fn(issued?.token ?? "");
  });
}

/** Register one plugin tab that only an operator.admin caller may open. */
function registerAdminOnlyPluginTab(): void {
  const registry = createEmptyPluginRegistry();
  registry.controlUiDescriptors.push({
    pluginId: "demo-plugin",
    source: "demo-plugin",
    descriptor: {
      surface: "tab",
      id: "demo",
      label: "Demo",
      path: "/secure-hook/panel",
      requiredScopes: ["operator.admin"],
    },
  });
  registry.httpRoutes.push({
    pluginId: "demo-plugin",
    source: "demo-plugin",
    path: "/secure-hook",
    auth: "gateway",
    match: "prefix",
    handler: async () => true,
  });
  setActivePluginRegistry(registry);
}

async function withControlUiRoot<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = testTempDirs.make("openclaw-ui-ts-scopes-");
  await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
  return await fn(tmp);
}

async function runBootstrapConfigRequest(params: { rootPath: string; req: IncomingMessage }) {
  const { res, end, setHeader } = makeMockHttpResponse();
  const handled = await handleControlUiHttpRequest(params.req, res, {
    auth: TAILSCALE_AUTH,
    root: { kind: "resolved", path: params.rootPath },
  });
  return { res, end, setHeader, handled };
}

function readResponseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]): string {
  return end.mock.calls.map((call) => String(call[0] ?? "")).join("");
}

function readPluginFrameGrants(
  end: ReturnType<typeof makeMockHttpResponse>["end"],
): ControlUiPluginFrameGrantAck[] | undefined {
  return (
    JSON.parse(readResponseBody(end)) as { pluginFrameGrants?: ControlUiPluginFrameGrantAck[] }
  ).pluginFrameGrants;
}

function pluginAuthCookieCalls(setHeader: ReturnType<typeof vi.fn>): unknown[] {
  return setHeader.mock.calls.filter((call) => String(call[0]).toLowerCase() === "set-cookie");
}

describe("control ui HTTP reads over Tailscale", () => {
  afterEach(() => {
    testTailscaleWhois.value = null;
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("refuses the bootstrap config read for an ambient Tailscale browser", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    await withControlUiRoot(async (tmp) => {
      const { res, handled } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({ url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH }),
      });
      expect(handled).toBe(true);
      // Verified tailnet identity and a same-origin fetch, and still nothing: the
      // dashboard boots by skipping this read until its websocket connect has
      // handed it a credential, so no Control UI read has an ambient lane left.
      expect(res.statusCode).toBe(401);
    });
  });

  it("grants no plugin frames and mints no plugin cookie for a credentialed Tailscale browser", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    registerAdminOnlyPluginTab();
    await withControlUiRoot(async (tmp) => {
      const { res, end, setHeader } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({
          url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          headers: { authorization: `Bearer ${postConnectDeviceCredential()}` },
        }),
      });
      expect(res.statusCode).toBe(200);
      // An admin-gated tab would only project if the request had been resolved
      // with CLI_DEFAULT_OPERATOR_SCOPES, which is exactly the amplification the
      // credential must not perform: it carries operator.read and nothing else.
      expect(readPluginFrameGrants(end)).toEqual([]);
      expect(pluginAuthCookieCalls(setHeader)).toEqual([]);
    });
  });

  it("ignores a self-asserted x-openclaw-scopes header on the credentialed read path", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    registerAdminOnlyPluginTab();
    await withControlUiRoot(async (tmp) => {
      const { res, end, setHeader } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({
          url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          headers: {
            authorization: `Bearer ${postConnectDeviceCredential()}`,
            "x-openclaw-scopes": "operator.admin,operator.write,operator.pairing",
          },
        }),
      });
      expect(res.statusCode).toBe(200);
      expect(readPluginFrameGrants(end)).toEqual([]);
      expect(pluginAuthCookieCalls(setHeader)).toEqual([]);
    });
  });

  it("still issues plugin frame grants for shared-secret bootstrap", async () => {
    registerAdminOnlyPluginTab();
    await withControlUiRoot(async (tmp) => {
      const { res, end } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: {
          url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          method: "GET",
          headers: { host: "gateway.local", authorization: "Bearer shared-token" },
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
      });
      expect(res.statusCode).toBe(200);
      // Proves the grant assertions above are not vacuous: the same registry and
      // the same route do issue grants when the caller proves operator authority.
      expect(readPluginFrameGrants(end)).toEqual([
        { pluginId: "demo-plugin", path: "/secure-hook", match: "prefix" },
      ]);
    });
  });

  it("refuses an ambient assistant-media ticket mint over Tailscale Serve", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-ambient-mint", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
        }),
      );

      expect(handled).toBe(true);
      // Ambient tailnet identity reaches neither half of this route. The metadata
      // read is a capability mint, so allowing it here would hand any same-origin
      // page on the tailnet a byte-read ticket with no credential at all.
      expect(res.statusCode).toBe(401);
      const body = readResponseBody(end);
      expect(body).not.toContain("mediaTicket");
      expect(body).not.toContain('"available"');
    });
  });

  it("completes bootstrap to metadata to ticket to bytes for a post-connect device credential", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    await withControlUiRoot(async (tmp) => {
      // The dashboard's real boot order on this lane: the config read it deferred
      // until hello supplied a credential is the credential's first customer.
      const bootstrap = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({
          url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          headers: { authorization: `Bearer ${postConnectDeviceCredential()}` },
        }),
      });
      expect(bootstrap.handled).toBe(true);
      expect(bootstrap.res.statusCode).toBe(200);
    });
    await withAssistantMediaFile("tailscale-scopes-principal-bound", async (filePath) => {
      const source = encodeURIComponent(filePath);
      const meta = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${source}`,
          headers: { authorization: `Bearer ${postConnectDeviceCredential()}` },
        }),
      );

      expect(meta.handled).toBe(true);
      expect(meta.res.statusCode).toBe(200);
      const availability = JSON.parse(readResponseBody(meta.end)) as {
        available?: boolean;
        mediaTicket?: string;
      };
      expect(availability.available).toBe(true);
      expect(availability.mediaTicket ?? "").toMatch(/^v1\./);

      // The ticket the credential bought is what unlocks the bytes, so the whole
      // recovered path is bound to a websocket connect that authenticated.
      const bytes = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?source=${source}&mediaTicket=${encodeURIComponent(
            availability.mediaTicket ?? "",
          )}`,
        }),
      );
      expect(bytes.handled).toBe(true);
      expect(bytes.res.statusCode).toBe(200);
    });
  });

  it("refuses a device credential the dashboard held past its deadline", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-expired-credential", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          headers: {
            authorization: `Bearer ${deviceCredentialIssuedAt(Date.now() - PAST_ANY_DEADLINE_MS)}`,
          },
        }),
      );

      expect(handled).toBe(true);
      // The TTL is the whole reason the browser renews: nothing on this side
      // extends a credential, so an aged one is refused on the same ingress,
      // for the same verified principal that minted it.
      expect(res.statusCode).toBe(401);
      expect(readResponseBody(end)).not.toContain("mediaTicket");
    });
  });

  it("serves assistant-media metadata to the credential a renewal reconnect minted", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-renewed-credential", async (filePath) => {
      // What `ui/src/app/control-ui-credential-renewal.ts` reconnects for: the
      // dashboard's original credential is long past its deadline, and the
      // replacement its pre-expiry reconnect obtained is what it now presents.
      const { res, end, handled } = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          headers: { authorization: `Bearer ${deviceCredentialIssuedAt(Date.now())}` },
        }),
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(readResponseBody(end)) as { available?: boolean }).available).toBe(true);
    });
  });

  it("refuses a credential minted before the operator disabled allowTailscale", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    // Minted while the lane was on, exactly as a live connect would have.
    const credential = postConnectDeviceCredential();
    // Nothing about the flip rotates the generation the credential is stamped
    // with, so the refusal below cannot be an accident of a stale signature —
    // the flag itself is the only thing that changed.
    expect(resolveSharedGatewaySessionGeneration(TAILSCALE_DISABLED_AUTH)).toBe(
      resolveSharedGatewaySessionGeneration(TAILSCALE_AUTH),
    );

    await withAssistantMediaFile("tailscale-scopes-allow-flag-flip", async (filePath) => {
      const url = `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`;
      const headers = { authorization: `Bearer ${credential}` };

      const allowed = await runAssistantMediaRequest(
        tailscaleServeRequest({ url, headers }),
        TAILSCALE_AUTH,
      );
      expect(allowed.res.statusCode).toBe(200);
      expect((JSON.parse(readResponseBody(allowed.end)) as { available?: boolean }).available).toBe(
        true,
      );

      const refused = await runAssistantMediaRequest(
        tailscaleServeRequest({ url, headers }),
        TAILSCALE_DISABLED_AUTH,
      );
      // A credential minted out of the Tailscale lane has to stop when the
      // operator turns that lane off, not run out its remaining 12h TTL against
      // a decision that has already been made.
      expect(refused.handled).toBe(true);
      expect(refused.res.statusCode).toBe(401);
      expect(readResponseBody(refused.end)).not.toContain("mediaTicket");
    });
  });

  it("keeps a paired device token working on Serve ingress when allowTailscale is off", async () => {
    testTailscaleWhois.value = { login: DASHBOARD_PRINCIPAL, name: "Peter" };
    await withPairedControlUiDeviceToken(async (operatorToken) => {
      await withAssistantMediaFile("tailscale-scopes-paired-device-flip", async (filePath) => {
        const url = `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`;
        const headers = { authorization: `Bearer ${operatorToken}` };

        // Gating redemption narrows the Serve credential only. A paired device
        // authenticated its own keypair and never depended on the Tailscale lane,
        // so it keeps its ingress-agnostic reach on both sides of the flip.
        for (const auth of [TAILSCALE_AUTH, TAILSCALE_DISABLED_AUTH]) {
          const { res, handled } = await runAssistantMediaRequest(
            tailscaleServeRequest({ url, headers }),
            auth,
          );
          expect(handled).toBe(true);
          expect(res.statusCode, `allowTailscale: ${auth.allowTailscale}`).toBe(200);
        }
      });
    });
  });

  it("refuses a device credential replayed off the managed Serve ingress", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-off-ingress", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        offServeIngressRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          headers: { authorization: `Bearer ${postConnectDeviceCredential()}` },
        }),
      );

      expect(handled).toBe(true);
      // The credential is pinned to the ingress it was issued on: a copy lifted
      // off that browser is worthless anywhere the tailnet does not reach.
      expect(res.statusCode).toBe(401);
      expect(readResponseBody(end)).not.toContain("mediaTicket");
    });
  });

  it("refuses a device credential presented by a different verified tailnet principal", async () => {
    const credential = postConnectDeviceCredential(DASHBOARD_PRINCIPAL);
    // A second tailnet user reaching the same managed Serve ingress, with their
    // own whois-verified identity, replays the first user's credential.
    testTailscaleWhois.value = { login: OTHER_PRINCIPAL, name: "Quinn" };
    await withAssistantMediaFile("tailscale-scopes-cross-principal", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          headers: {
            authorization: `Bearer ${credential}`,
            "tailscale-user-login": OTHER_PRINCIPAL,
            "tailscale-user-name": "Quinn",
          },
        }),
      );

      expect(handled).toBe(true);
      // Managed-Serve ingress is a class, not a principal: without this check the
      // credential would spend its full TTL for anyone else on the tailnet.
      expect(res.statusCode).toBe(401);
      expect(readResponseBody(end)).not.toContain("mediaTicket");
    });
  });

  it("refuses a device credential when the presenting request has no verifiable identity", async () => {
    const credential = postConnectDeviceCredential();
    // The forwarded login header is present but whois does not corroborate it,
    // so there is no verified principal to compare the credential's claim to.
    testTailscaleWhois.value = null;
    await withAssistantMediaFile("tailscale-scopes-unverified-principal", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          headers: { authorization: `Bearer ${credential}` },
        }),
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(readResponseBody(end)).not.toContain("mediaTicket");
    });
  });

  it.each([null, undefined, "", "   "])(
    "mints no credential for a connect whose principal is %j",
    (principal) => {
      // Redemption refuses an unbound claim set, but the load-bearing half of that
      // guarantee is here: an unbound credential is not a shape production can
      // produce. A connect with no whois-verified login to bind gets nothing, so
      // the browser is left presenting no bearer rather than an unbindable one.
      expect(
        issueControlUiDeviceCredential({
          deviceId: "device-tailscale-serve-dashboard",
          principal,
          authGeneration: resolveSharedGatewaySessionGeneration(TAILSCALE_AUTH),
        }),
      ).toBeNull();
    },
  );

  it("still refuses a cross-site assistant-media ticket mint over Tailscale Serve", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res, end, handled } = await runAssistantMediaRequest(
      tailscaleServeRequest({
        url: "/__openclaw__/assistant-media?source=/etc/hosts&meta=1",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(readResponseBody(end)).not.toContain("mediaTicket");
  });

  it("refuses an assistant-media byte read for a device-less Tailscale browser", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res, handled } = await runAssistantMediaRequest(
      tailscaleServeRequest({ url: "/__openclaw__/assistant-media?source=/etc/hosts" }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("fails the bootstrap read closed on unattributable tailnet-shaped headers", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withControlUiRoot(async (tmp) => {
      const { res, end } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: spoofedTailscaleHeaderRequest(CONTROL_UI_BOOTSTRAP_CONFIG_PATH),
      });
      // Tailnet-shaped headers are attacker-supplied on any other ingress, so the
      // request fails closed on attribution before identity is ever consulted:
      // only the managed Serve listener's own marking makes those headers evidence.
      expect(res.statusCode).toBe(403);
      expect(readResponseBody(end)).toContain("proxy_attribution_required");
    });
  });

  it("refuses an avatar read for a device-less Tailscale browser", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res } = makeMockHttpResponse();
    const handled = await handleControlUiAvatarRequest(
      tailscaleServeRequest({ url: "/avatar/default" }),
      res,
      { auth: TAILSCALE_AUTH, config: {} },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });
});
