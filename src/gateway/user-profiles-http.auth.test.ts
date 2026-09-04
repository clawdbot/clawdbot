import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

vi.mock("../infra/host-account-name.js", () => ({
  resolveHostAccountName: async () => "Avatar test owner",
}));

async function withProfileAvatarGateway(
  run: (fixture: {
    auth: ResolvedGatewayAuth;
    deviceId: string;
    token: string;
    avatarPath: string;
    request: (
      pathname: string,
      bearer?: string,
      headers?: Record<string, string>,
    ) => Promise<Response>;
  }) => Promise<void>,
  scopes = ["operator.read"],
) {
  await withOpenClawTestState({ label: "profile-avatar-auth" }, async (state) => {
    const auth: ResolvedGatewayAuth = {
      mode: "token",
      token: "profile-avatar-shared-secret",
      allowTailscale: false,
    };
    await state.writeConfig({ gateway: { auth: { mode: "token", token: auth.token } } });
    const owner = ensureGatewayOwnerProfile("Avatar test owner");
    expect(setAvatar(owner.id, Buffer.from("avatar-bytes"), "image/png").ok).toBe(true);
    const deviceId = "profile-avatar-browser";
    const pending = await requestDevicePairing({
      deviceId,
      publicKey: "profile-avatar-public-key",
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      role: "operator",
      scopes,
    });
    const approved = await approveDevicePairing(pending.request.requestId, {
      callerScopes: scopes,
    });
    expect(approved?.status).toBe("approved");
    const token = await ensureDeviceToken({
      deviceId,
      role: "operator",
      scopes,
      issuer: {
        kind: "shared-gateway-auth",
        generation: resolveSharedGatewaySessionGeneration(auth)!,
      },
    });
    if (!token) {
      throw new Error("paired browser token was not issued");
    }
    const limiter = createAuthRateLimiter();
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      handleHooksRequest: async () => false,
      resolvedAuth: auth,
      rateLimiter: limiter,
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("avatar HTTP server has no loopback port");
      }
      await run({
        auth,
        deviceId,
        token: token.token,
        avatarPath: `/api/users/${owner.id}/avatar`,
        request: (pathname, bearer, headers) =>
          fetch(`http://127.0.0.1:${address.port}${pathname}`, {
            headers: { ...headers, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
          }),
      });
    } finally {
      limiter.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

describe("profile avatar paired-browser authentication", () => {
  it("serves repeated browser reads and releases their root work before limiter disposal", async () => {
    await withProfileAvatarGateway(async ({ request, avatarPath, token }) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await request(avatarPath, token);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(await response.text()).toBe("avatar-bytes");
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      }
    });
  });

  it.each(["revoked", "stale-generation", "missing-read-scope"] as const)(
    "rejects a %s browser credential",
    async (failure) => {
      await withProfileAvatarGateway(
        async ({ auth, deviceId, request, avatarPath, token }) => {
          if (failure !== "missing-read-scope") {
            const before = await request(avatarPath, token);
            expect(before.status).toBe(200);
            expect(await before.text()).toBe("avatar-bytes");
          }
          if (failure === "revoked") {
            expect((await revokeDeviceToken({ deviceId, role: "operator" })).ok).toBe(true);
          } else if (failure === "stale-generation") {
            auth.token = "rotated-profile-avatar-shared-secret";
          }
          const response = await request(avatarPath, token, {
            "x-openclaw-scopes": "operator.admin,operator.read",
          });
          expect(response.status).toBe(401);
          expect(await response.text()).not.toContain("avatar-bytes");
        },
        failure === "missing-read-scope" ? ["operator.approvals"] : undefined,
      );
    },
  );

  it("does not grant paired-device authentication to ordinary HTTP APIs", async () => {
    await withProfileAvatarGateway(async ({ auth, request, token }) => {
      const pathname = "/sessions/missing-session/history";
      const deviceResponse = await request(pathname, token);
      expect(deviceResponse.status).toBe(401);
      await deviceResponse.text();
      const sharedResponse = await request(pathname, auth.token);
      expect(sharedResponse.status).toBe(404);
      await sharedResponse.text();
    });
  });

  it("preserves explicitly narrowed HTTP scopes when authentication is disabled", async () => {
    await withProfileAvatarGateway(async ({ auth, request, avatarPath }) => {
      auth.mode = "none";
      const denied = await request(avatarPath, undefined, { "x-openclaw-scopes": "" });
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain("avatar-bytes");
      const allowed = await request(avatarPath, undefined, {
        "x-openclaw-scopes": "operator.read",
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe("avatar-bytes");
    });
  });
});
