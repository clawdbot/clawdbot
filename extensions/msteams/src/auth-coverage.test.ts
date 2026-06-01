/**
 * Auth coverage tests for the SDK migration (#76262 reviewer ask from
 * @BradGroux). Locks in three contract guarantees that the SDK's built-in
 * JWT validation must satisfy:
 *
 *   1. Inbound Bot Framework tokens with `aud=<bot app id>` are accepted.
 *   2. Inbound tokens with `aud=https://api.botframework.com` are rejected,
 *      even when the `appid` claim matches the bot. That audience belongs to
 *      the SMBA/ABS Connector resource (token issued *for* the Connector);
 *      accepting it inbound on the bot would be a confused-deputy that
 *      contradicts the Entra audience-validation guidance.
 *   3. The 2.0.10 SDK bump's v1-issuer support is exercised: Entra tokens
 *      issued by the legacy `https://sts.windows.net/{tenantId}/` endpoint
 *      are accepted alongside the v2 `https://login.microsoftonline.com/...`
 *      endpoint when `allowedTenantIds` is configured.
 *
 * The tests reach into `@microsoft/teams.apps`'s internal middleware/auth
 * subpath to drive `ServiceTokenValidator` and `createEntraTokenValidator`
 * directly. Those aren't part of the SDK's public barrel today; if they
 * shift in a future SDK release this file lights up clearly. We chose this
 * over standing up an Express + supertest harness because the contract being
 * tested is purely the validator's accept/reject behavior — the surrounding
 * HTTP plumbing is a separate concern covered by `monitor.lifecycle.test.ts`.
 *
 * `JwksClient.prototype.getSigningKey` is patched to return a single
 * in-memory test public key so we don't hit `login.botframework.com` /
 * `login.microsoftonline.com` during the test. `jose` (devDep) mints RS256
 * tokens against the matching private key.
 */

// Internal subpath imports. See file header for the rationale.
import { createEntraTokenValidator } from "@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js";
import { ServiceTokenValidator } from "@microsoft/teams.apps/dist/middleware/auth/service-token-validator.js";
import type { ILogger } from "@microsoft/teams.common";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { JwksClient, type SigningKey } from "jwks-rsa";
import { beforeAll, describe, expect, it, vi } from "vitest";

const APP_ID = "test-app-id";
const TENANT_ID = "test-tenant-id";
const TEST_KID = "test-key-id";

let privateKey: CryptoKey;
let publicPem: string;

async function mintToken(claims: Record<string, unknown>): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256", {
    modulusLength: 2048,
  });
  privateKey = priv;
  publicPem = await exportSPKI(publicKey);

  // Patch `JwksClient.prototype.getSigningKeys` so every JWKS lookup the SDK
  // performs returns our in-memory test key instead of fetching from
  // `login.botframework.com` / `login.microsoftonline.com` while preserving
  // the package's callback/promise getSigningKey wrapper behavior.
  vi.spyOn(JwksClient.prototype, "getSigningKeys").mockResolvedValue([
    {
      kid: TEST_KID,
      alg: "RS256",
      getPublicKey: () => publicPem,
      rsaPublicKey: publicPem,
    } as SigningKey,
  ]);
});

// Logger that surfaces SDK validation failures so we can see *why* a token
// was rejected when the test fails. `error` is what the SDK uses for
// rejection reasons; the rest are no-ops to keep the test output clean.
const debugLogger: ILogger = {
  child: () => debugLogger,
  debug: () => {},
  info: () => {},
  error: (...args: unknown[]) => console.error("[sdk]", ...args),
  warn: () => {},
  log: () => {},
  trace: () => {},
};

describe("ServiceTokenValidator (inbound Bot Framework)", () => {
  it("accepts a token whose audience matches the bot app id", async () => {
    const validator = new ServiceTokenValidator(APP_ID, undefined, undefined, debugLogger);
    const token = await mintToken({
      aud: APP_ID,
      iss: "https://api.botframework.com",
    });

    const result = await validator.check(`Bearer ${token}`, { id: "activity-1" });

    expect(result.appId).toBe(APP_ID);
  });

  it("rejects a token with aud=api.botframework.com even when the appid claim matches the bot", async () => {
    const validator = new ServiceTokenValidator(APP_ID);
    // This is the confused-deputy shape: the token was issued *for* the
    // Connector resource (`aud=https://api.botframework.com`) and happens to
    // carry the bot's app id in `appid`. The SDK must reject it on the
    // audience check before any appid/azp logic runs.
    const token = await mintToken({
      aud: "https://api.botframework.com",
      iss: "https://api.botframework.com",
      appid: APP_ID,
      azp: APP_ID,
    });

    await expect(validator.check(`Bearer ${token}`, { id: "activity-2" })).rejects.toThrow();
  });
});

describe("createEntraTokenValidator (Entra access tokens — SDK 2.0.10 v1 issuer fix)", () => {
  it("accepts the v1 sts.windows.net issuer for an allowed tenant", async () => {
    const validator = createEntraTokenValidator(TENANT_ID, APP_ID, {
      allowedTenantIds: [TENANT_ID],
    });
    const token = await mintToken({
      aud: APP_ID,
      iss: `https://sts.windows.net/${TENANT_ID}/`,
    });

    const payload = await validator.validateAccessToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.iss).toBe(`https://sts.windows.net/${TENANT_ID}/`);
  });

  it("accepts the v2 login.microsoftonline.com issuer for an allowed tenant", async () => {
    const validator = createEntraTokenValidator(TENANT_ID, APP_ID, {
      allowedTenantIds: [TENANT_ID],
    });
    const token = await mintToken({
      aud: APP_ID,
      iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    });

    const payload = await validator.validateAccessToken(token);

    expect(payload).not.toBeNull();
  });

  it("rejects an issuer for a tenant that is not allowed", async () => {
    const validator = createEntraTokenValidator(TENANT_ID, APP_ID, {
      allowedTenantIds: [TENANT_ID],
    });
    const token = await mintToken({
      aud: APP_ID,
      iss: `https://sts.windows.net/some-other-tenant-id/`,
    });

    // The SDK's `validateAccessToken` resolves to `null` (rather than
    // throwing) when issuer/audience/signature checks fail. The contract we
    // care about is "this token does not yield a payload" — both shapes are
    // valid rejections; we just want to be sure a non-allowed tenant does
    // not produce a usable payload.
    const payload = await validator.validateAccessToken(token);
    expect(payload).toBeNull();
  });
});
