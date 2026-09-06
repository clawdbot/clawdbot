import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveControlUiAuthCandidates } from "../../ui/src/app/control-ui-auth.ts";
import { setAvatarGatewayOrigin } from "../../ui/src/lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../../ui/src/lib/identity-avatar-loader.ts";
import * as configIo from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../state/user-profiles.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Only config is substituted: requests cross real HTTP, auth, device pairing,
// profile storage and (in the reported path) the UI's credential picker/loader.
describe("personal avatar HTTP authentication", () => {
  let server: Server;
  let origin: string;
  let avatarPath: string;
  let auth: ResolvedGatewayAuth;
  let cfg: OpenClawConfig;
  let rateLimiter: AuthRateLimiter | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const pathname = new URL(req.url ?? "/", origin).pathname;
        if (pathname === "/generic") {
          if (await authorizeGatewayHttpRequestOrReply({ req, res, auth })) {
            res.end("ok");
          }
          return;
        }
        await handleUserProfileAvatarHttpRequest(req, res, pathname, { auth, rateLimiter });
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an HTTP listener");
    }
    origin = "http://127.0.0.1:" + address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("personal-avatar-auth-"));
    cfg = {};
    auth = { mode: "token", token: "test-shared-secret", allowTailscale: false };
    vi.spyOn(configIo, "getRuntimeConfig").mockImplementation(() => cfg);
    const profile = ensureGatewayOwnerProfile("Avatar test owner");
    expect(setAvatar(profile.id, PNG, "image/png").ok).toBe(true);
    avatarPath = "/api/users/gateway-owner/avatar?v=synthetic-png";
  });

  afterEach(() => {
    setAvatarGatewayOrigin(null);
    rateLimiter?.dispose();
    rateLimiter = undefined;
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function pairDevice(scopes = ["operator.read"], role = "operator") {
    const deviceId = "avatar-test-device";
    const requested = await requestDevicePairing({
      deviceId,
      publicKey: "test-public-key",
      role,
      scopes,
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
    });
    const approved = await approveDevicePairing(requested.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    expect(approved?.status).toBe("approved");
    const issued = await ensureDeviceToken({
      deviceId,
      role,
      scopes,
      issuer: {
        kind: "shared-gateway-auth",
        generation: resolveSharedGatewaySessionGeneration(auth)!,
      },
    });
    if (!issued) {
      throw new Error("device token issuance failed");
    }
    return { deviceId, token: issued.token };
  }

  function request(credential?: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (credential) {
      headers.set("Authorization", "Bearer " + credential);
    }
    return fetch(origin + avatarPath, { ...init, headers });
  }

  it.each(["token", "password", "trusted-proxy"] as const)(
    "loads the saved personal photo with the connected credentials under %s auth",
    async (mode) => {
      auth =
        mode === "trusted-proxy"
          ? {
              mode,
              password: "test-shared-secret",
              trustedProxy: { userHeader: "x-auth-user" },
              allowTailscale: false,
            }
          : { mode, [mode]: "test-shared-secret", allowTailscale: false };
      cfg = { gateway: { trustedProxies: ["127.0.0.1"] } };
      const { token } = await pairDevice();
      expect((await request("test-shared-secret")).status).toBe(200);
      if (mode === "trusted-proxy") {
        // A tunnel may use the configured local password; paired HTTP tokens
        // must not bypass the proxy identity boundary on their own.
        expect((await request(token)).status).toBe(401);
      }
      // The live hello credential wins even with saved shared credentials.
      const candidates = resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: token } },
        settings: { token: mode === "trusted-proxy" ? "" : "test-shared-secret" },
        password: "test-shared-secret",
      });
      expect(candidates[0] === token).toBe(true);
      setAvatarGatewayOrigin(origin, candidates);
      const blobUrl = await resolveAvatarImageUrl(avatarPath);
      expect(blobUrl?.startsWith("blob:")).toBe(true);
      const image = await fetch(blobUrl!);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    },
  );

  it("allows device-only clients and authenticates HEAD and ETag revalidation", async () => {
    const { token } = await pairDevice();
    const response = await request(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const head = await request(token, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const unchanged = await request(token, {
      headers: { "If-None-Match": response.headers.get("etag")! },
    });
    expect(unchanged.status).toBe(304);
    expect(
      (await request(undefined, { headers: { "If-None-Match": response.headers.get("etag")! } }))
        .status,
    ).toBe(401);
    // The same paired credential must not become a generic HTTP credential.
    expect(
      (await fetch(origin + "/generic", { headers: { Authorization: "Bearer " + token } })).status,
    ).toBe(401);
  });

  it.each([
    "missing",
    "invalid",
    "query-only",
    "revoked",
    "stale-generation",
    "no-read-scope",
    "node-role",
  ])("rejects %s credentials before returning avatar bytes", async (kind) => {
    const { deviceId, token } = await pairDevice(
      kind === "no-read-scope"
        ? ["operator.approvals"]
        : kind === "node-role"
          ? []
          : ["operator.read"],
      kind === "node-role" ? "node" : "operator",
    );
    if (kind === "revoked") {
      await revokeDeviceToken({ deviceId, role: "operator" });
    }
    if (kind === "stale-generation") {
      auth = { ...auth, token: "rotated-test-secret" };
    }
    if (kind === "query-only") {
      avatarPath += "&token=" + encodeURIComponent(token);
    }
    const credential =
      kind === "missing" || kind === "query-only"
        ? undefined
        : kind === "invalid"
          ? "invalid-test-token"
          : token;
    const response = await request(credential, {
      headers: { "x-openclaw-scopes": "operator.admin" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("image/png");
  });

  it("fails closed for unbound device identities when profile roles are configured", async () => {
    const { token } = await pairDevice();
    cfg = { gateway: { roles: { definitions: {} } } };
    expect((await request(token)).status).toBe(401);
    expect((await request("test-shared-secret")).status).toBe(200);
  });

  it("does not spend the shared-secret failure budget on valid paired reads", async () => {
    const { token } = await pairDevice();
    rateLimiter = createAuthRateLimiter({ maxAttempts: 1, exemptLoopback: false });
    expect((await request(token)).status).toBe(200);
    expect((await request(token)).status).toBe(200);
    expect((await request("test-shared-secret")).status).toBe(200);
    expect((await request("invalid-test-token")).status).toBe(401);
    expect((await request("invalid-test-token")).status).toBe(429);
  });
});
