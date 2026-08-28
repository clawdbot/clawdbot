import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBuzzAccountIds, resolveBuzzAccount } from "./types.js";

const PRIVATE_KEY = "11".repeat(32);
const ENV_PRIVATE_KEY = "22".repeat(32);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("listBuzzAccountIds", () => {
  it("discovers the default account from a configured private-key SecretRef", () => {
    const cfg = {
      channels: {
        buzz: {
          privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
        },
      },
    } as OpenClawConfig;

    expect(listBuzzAccountIds(cfg)).toEqual(["default"]);
  });
});

describe("resolveBuzzAccount", () => {
  it.each([
    {
      label: "keeps explicit plaintext credentials ahead of ambient credentials",
      credentials: { privateKey: PRIVATE_KEY, authTag: "configured-auth-tag" },
      env: { BUZZ_PRIVATE_KEY: ENV_PRIVATE_KEY, BUZZ_AUTH_TAG: "ambient-auth-tag" },
      expected: {
        configured: true,
        privateKey: PRIVATE_KEY,
        authTag: "configured-auth-tag",
        tokenStatus: "available",
      },
    },
    {
      label: "distinguishes a missing private key from a configured unavailable key",
      credentials: {},
      env: { BUZZ_PRIVATE_KEY: "" },
      expected: { configured: false, privateKey: "", tokenStatus: "missing" },
    },
    {
      label: "never substitutes an ambient private key for an unavailable SecretRef",
      credentials: {
        privateKey: { source: "env", provider: "default", id: "MISSING_BUZZ_PRIVATE_KEY" },
      },
      env: { BUZZ_PRIVATE_KEY: ENV_PRIVATE_KEY },
      expected: {
        configured: true,
        privateKey: "",
        publicKey: "",
        tokenStatus: "configured_unavailable",
      },
    },
    {
      label: "never substitutes an ambient auth tag for an unavailable SecretRef",
      credentials: {
        privateKey: PRIVATE_KEY,
        authTag: { source: "env", provider: "default", id: "MISSING_BUZZ_AUTH_TAG" },
      },
      env: { BUZZ_AUTH_TAG: "ambient-auth-tag" },
      expected: {
        configured: true,
        privateKey: PRIVATE_KEY,
        authTag: "",
        publicKey: expect.stringMatching(/./),
        tokenStatus: "configured_unavailable",
      },
    },
  ] as const)("$label", ({ credentials, env, expected }) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    const cfg = {
      channels: {
        buzz: { relayUrl: "wss://buzz.example.com", ...credentials },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg })).toMatchObject(expected);
  });
});
