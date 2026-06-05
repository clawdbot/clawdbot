// Talk config tests cover speech-provider config resolution, secret redaction,
// device-authenticated access, and protocol payload validation.
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateTalkConfigResult } from "../../packages/gateway-protocol/src/index.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { withSpeechProviders } from "./talk.test-helpers.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
type SecretRef = { source?: string; provider?: string; id?: string };
type TalkConfigPayload = {
  config?: {
    talk?: {
      provider?: string;
      providers?: {
        [providerId: string]: { voiceId?: string; apiKey?: string | SecretRef } | undefined;
      };
      resolved?: {
        provider?: string;
        config?: { voiceId?: string; apiKey?: string | SecretRef };
      };
      speechLocale?: string;
      silenceTimeoutMs?: number;
    };
    session?: { mainKey?: string };
    ui?: { seamColor?: string };
  };
};
type TalkConfig = NonNullable<NonNullable<TalkConfigPayload["config"]>["talk"]>;
type SpeechProviderFixture = Parameters<typeof withSpeechProviders>[0][number];
const GENERIC_TALK_PROVIDER_ID = "acme";
const GENERIC_TALK_API_ENV = "ACME_SPEECH_API_KEY";
let harness: GatewayHarness;
let talkConfigDeviceSeq = 0;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "token", token: "secret" } },
  });
});

afterAll(async () => {
  await harness.close();
});

async function createFreshOperatorDevice(scopes: string[], nonce: string) {
  const identity = loadOrCreateDeviceIdentity(
    path.join(os.tmpdir(), `openclaw-talk-config-device-${process.pid}-${talkConfigDeviceSeq++}`),
  );
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: "test",
    clientMode: "test",
    role: "operator",
    scopes,
    signedAtMs,
    token: "secret",
    nonce,
  });

  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}

async function connectOperator(ws: GatewaySocket, scopes: string[]) {
  const nonce = await readConnectChallengeNonce(ws);
  expect(nonce).toBeTypeOf("string");
  expect(String(nonce).length).toBeGreaterThan(0);
  await connectOk(ws, {
    token: "secret",
    scopes,
    device: await createFreshOperatorDevice(scopes, String(nonce)),
  });
}

async function writeTalkConfig(config: {
  provider?: string;
  apiKey?: string | { source: "env" | "file" | "exec"; provider: string; id: string };
  voiceId?: string;
  silenceTimeoutMs?: number;
}) {
  const { writeConfigFile } = await import("../config/config.js");
  const providerId = config.provider ?? GENERIC_TALK_PROVIDER_ID;
  await writeConfigFile({
    talk: {
      provider: providerId,
      silenceTimeoutMs: config.silenceTimeoutMs,
      providers:
        config.apiKey !== undefined || config.voiceId !== undefined
          ? {
              [providerId]: {
                ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
                ...(config.voiceId !== undefined ? { voiceId: config.voiceId } : {}),
              },
            }
          : undefined,
    },
  });
}

async function fetchTalkConfig(
  ws: GatewaySocket,
  params?: { includeSecrets?: boolean } | Record<string, unknown>,
) {
  return rpcReq<TalkConfigPayload>(ws, "talk.config", params ?? {}, 60_000);
}

async function fetchOkTalkConfig(
  ws: GatewaySocket,
  params?: { includeSecrets?: boolean } | Record<string, unknown>,
) {
  const res = await fetchTalkConfig(ws, params);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res;
}

async function withTalkConfigConnection<T>(
  scopes: string[],
  run: (ws: GatewaySocket) => Promise<T>,
): Promise<T> {
  const ws = await harness.openWs();
  try {
    await connectOperator(ws, scopes);
    return await run(ws);
  } finally {
    ws.close();
  }
}

function talkApiSecretRef() {
  return {
    source: "env" as const,
    provider: "default",
    id: GENERIC_TALK_API_ENV,
  } satisfies SecretRef;
}

function speechProviderFixture(params: {
  pluginId: string;
  label: string;
  resolveTalkConfig?: SpeechProviderFixture["provider"]["resolveTalkConfig"];
}): SpeechProviderFixture {
  return {
    pluginId: params.pluginId,
    source: "test",
    provider: {
      id: GENERIC_TALK_PROVIDER_ID,
      label: params.label,
      isConfigured: () => true,
      resolveTalkConfig:
        params.resolveTalkConfig ?? (({ talkProviderConfig }) => talkProviderConfig),
      synthesize: async () => ({
        audioBuffer: Buffer.from([1]),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      }),
    },
  };
}

async function expectTalkSecretsConfig(
  expected: Omit<Parameters<typeof expectTalkConfig>[1], "provider">,
) {
  await withTalkConfigConnection(
    ["operator.read", "operator.write", "operator.talk.secrets"],
    async (ws) => {
      const res = await fetchOkTalkConfig(ws, { includeSecrets: true });
      expect(validateTalkConfigResult(res.payload)).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        ...expected,
      });
    },
  );
}

function expectTalkConfig(
  talk: TalkConfig | undefined,
  expected: {
    provider: string;
    voiceId?: string;
    apiKey?: string | SecretRef;
    providerApiKey?: string | SecretRef;
    resolvedApiKey?: string | SecretRef;
    speechLocale?: string;
    silenceTimeoutMs?: number;
  },
) {
  expect(talk?.provider).toBe(expected.provider);
  expect(talk?.providers?.[expected.provider]?.voiceId).toBe(expected.voiceId);
  expect(talk?.resolved?.provider).toBe(expected.provider);
  expect(talk?.resolved?.config?.voiceId).toBe(expected.voiceId);

  if ("apiKey" in expected) {
    expect(talk?.providers?.[expected.provider]?.apiKey).toEqual(expected.apiKey);
    expect(talk?.resolved?.config?.apiKey).toEqual(expected.apiKey);
  }
  if ("providerApiKey" in expected) {
    expect(talk?.providers?.[expected.provider]?.apiKey).toEqual(expected.providerApiKey);
  }
  if ("resolvedApiKey" in expected) {
    expect(talk?.resolved?.config?.apiKey).toEqual(expected.resolvedApiKey);
  }
  if ("speechLocale" in expected) {
    expect(talk?.speechLocale).toBe(expected.speechLocale);
  }
  if ("silenceTimeoutMs" in expected) {
    expect(talk?.silenceTimeoutMs).toBe(expected.silenceTimeoutMs);
  }
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: GENERIC_TALK_PROVIDER_ID,
        providers: {
          [GENERIC_TALK_PROVIDER_ID]: {
            voiceId: "voice-123",
            apiKey: "secret-key-abc", // pragma: allowlist secret
          },
        },
        speechLocale: "ru-RU",
        silenceTimeoutMs: 1500,
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchOkTalkConfig(ws);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        voiceId: "voice-123",
        apiKey: "__OPENCLAW_REDACTED__",
        speechLocale: "ru-RU",
        silenceTimeoutMs: 1500,
      });
      expect(res.payload?.config?.session?.mainKey).toBe("main-test");
      expect(res.payload?.config?.ui?.seamColor).toBe("#112233");
    });
  });

  it("rejects invalid talk.config params", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // pragma: allowlist secret

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchTalkConfig(ws, { includeSecrets: "yes" });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("invalid talk.config params");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // pragma: allowlist secret

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchTalkConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it.each([
    ["operator.talk.secrets", ["operator.read", "operator.write", "operator.talk.secrets"]],
    ["operator.admin", ["operator.read", "operator.admin"]],
  ] as const)("returns secrets for %s scope", async (_label, scopes) => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // pragma: allowlist secret

    await withTalkConfigConnection([...scopes], async (ws) => {
      const res = await fetchTalkConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        apiKey: "secret-key-abc",
      });
    });
  });

  it("returns Talk SecretRef payloads that satisfy the protocol schema", async () => {
    await writeTalkConfig({
      apiKey: talkApiSecretRef(),
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await expectTalkSecretsConfig({ apiKey: talkApiSecretRef() });
    });
  });

  it("preserves configured Talk provider data when plugin-owned defaults exist", async () => {
    await writeTalkConfig({
      provider: GENERIC_TALK_PROVIDER_ID,
      voiceId: "voice-from-config",
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withSpeechProviders(
        [
          speechProviderFixture({
            pluginId: "acme-talk-defaults-test",
            label: "Acme Speech",
            resolveTalkConfig: ({ talkProviderConfig }) => ({
              ...talkProviderConfig,
              apiKey:
                typeof process.env[GENERIC_TALK_API_ENV] === "string"
                  ? process.env[GENERIC_TALK_API_ENV]
                  : undefined,
            }),
          }),
        ],
        async () => {
          await withTalkConfigConnection(["operator.read"], async (ws) => {
            const res = await fetchOkTalkConfig(ws);
            expectTalkConfig(res.payload?.config?.talk, {
              provider: GENERIC_TALK_PROVIDER_ID,
              voiceId: "voice-from-config",
              providerApiKey: undefined,
            });
          });
        },
      );
    });
  });

  it("redacts SecretRef apiKey after strict provider resolver accepts it", async () => {
    // Regression for #72496: ElevenLabs/OpenAI speech providers call the strict
    // normalizeResolvedSecretInputString helper inside resolveTalkConfig. The
    // discovery path used to hand them the raw source config (with the SecretRef
    // wrapper still intact), causing talk.config to throw "unresolved SecretRef"
    // and pushing iOS/macOS Talk overlays onto local AVSpeechSynthesizer.
    const apiKeyPath = `talk.providers.${GENERIC_TALK_PROVIDER_ID}.apiKey`;
    await writeTalkConfig({
      apiKey: talkApiSecretRef(),
      voiceId: "voice-secretref",
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withSpeechProviders(
        [
          speechProviderFixture({
            pluginId: "acme-strict-talk-provider-test",
            label: "Acme Strict Speech",
            resolveTalkConfig: ({ talkProviderConfig }) => {
              const apiKey = normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: apiKeyPath,
              });
              return {
                ...talkProviderConfig,
                ...(apiKey === undefined ? {} : { apiKey }),
              };
            },
          }),
        ],
        async () => {
          await withTalkConfigConnection(["operator.read"], async (ws) => {
            const res = await fetchOkTalkConfig(ws);
            const talk = res.payload?.config?.talk;
            expect(talk?.provider).toBe(GENERIC_TALK_PROVIDER_ID);
            expect(talk?.providers?.[GENERIC_TALK_PROVIDER_ID]?.voiceId).toBe("voice-secretref");
            // SecretRef apiKey is redacted in-place; the wrapper shape stays so
            // the UI keeps the SecretRef context, but every field becomes the
            // sentinel so no credential material leaks to read-scope callers.
            const redactedApiKey = talk?.providers?.[GENERIC_TALK_PROVIDER_ID]?.apiKey;
            expect(redactedApiKey).toEqual({
              id: "__OPENCLAW_REDACTED__",
              provider: "__OPENCLAW_REDACTED__",
              source: "__OPENCLAW_REDACTED__",
            });
            expect(talk?.resolved?.config?.apiKey).toEqual(redactedApiKey);
          });

          await expectTalkSecretsConfig({
            voiceId: "voice-secretref",
            apiKey: talkApiSecretRef(),
          });
        },
      );
    });
  });

  it("does not pollute Object.prototype when messages.tts.providers contains a __proto__ key", async () => {
    // Hardening regression: stripUnresolvedSecretApiKeysFromBaseTtsProviders
    // rebuilds the providers map with dynamic keys from operator config. Using
    // a plain `{}` would let `cleaned['__proto__'] = {...}` mutate
    // Object.prototype. The helper uses `Object.create(null)` to make that
    // assignment a normal property write on the local map instead.
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: GENERIC_TALK_PROVIDER_ID,
        providers: {
          [GENERIC_TALK_PROVIDER_ID]: {
            voiceId: "voice-proto-pollution-guard",
          },
        },
      },
      messages: {
        tts: {
          provider: GENERIC_TALK_PROVIDER_ID,
          providers: {
            [GENERIC_TALK_PROVIDER_ID]: {
              apiKey: talkApiSecretRef(),
            },
            // Hostile operator-config payload — not a real provider id, just
            // a value-shaped key with a SecretRef-shaped apiKey to force the
            // strip path.
            __proto__: {
              apiKey: talkApiSecretRef(),
              polluted: "yes",
            },
          },
        },
      },
    });

    const sentinelKeyBefore = ({} as Record<string, unknown>).polluted;

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withSpeechProviders(
        [
          speechProviderFixture({
            pluginId: "acme-strict-tts-proto-test",
            label: "Acme Strict Speech (proto guard)",
          }),
        ],
        async () => {
          await withTalkConfigConnection(["operator.read"], async (ws) => {
            const res = await fetchOkTalkConfig(ws);
            // The active provider's voice still comes through cleanly.
            expect(res.payload?.config?.talk?.provider).toBe(GENERIC_TALK_PROVIDER_ID);
          });
        },
      );
    });

    // The strip helper must not have leaked the hostile `polluted` field onto
    // Object.prototype: a fresh empty object should not gain a `.polluted`
    // property as a side effect of processing the request.
    const sentinelKeyAfter = ({} as Record<string, unknown>).polluted;
    expect(sentinelKeyAfter).toBe(sentinelKeyBefore);
    expect(sentinelKeyAfter).toBeUndefined();
  });

  it("returns canonical provider talk payloads", async () => {
    await writeTalkConfig({
      provider: GENERIC_TALK_PROVIDER_ID,
      voiceId: "voice-normalized",
    });

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchOkTalkConfig(ws);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        voiceId: "voice-normalized",
      });
    });
  });
});
