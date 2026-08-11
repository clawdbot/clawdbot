// OpenAI realtime auth precedence tests use the production SQLite-backed profile store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const sideEffects = vi.hoisted(() => ({
  resolveSubscriptionAuth: vi.fn(),
  webSocket: vi.fn(),
}));

vi.mock("ws", () => {
  class UnexpectedWebSocket {
    static readonly OPEN = 1;

    constructor(...args: unknown[]) {
      sideEffects.webSocket(...args);
      throw new Error("unexpected realtime WebSocket side effect");
    }
  }

  return { default: UnexpectedWebSocket };
});

vi.mock("./realtime-quicksilver-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./realtime-quicksilver-session.js")>()),
  resolveOpenAIChatGptSubscriptionAuth: sideEffects.resolveSubscriptionAuth,
}));

import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const PROFILE_ID = "openai:selected";
const MODEL = "gpt-live-1-boulder-alpha";

function createConfig(agentDir: string, mode: "api_key" | "oauth" = "api_key"): OpenClawConfig {
  return {
    agents: { list: [{ id: "voice", agentDir }] },
    auth: {
      profiles: {
        [PROFILE_ID]: { provider: "openai", mode },
      },
      order: { openai: [PROFILE_ID] },
    },
  };
}

function createTestJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

async function expectSelectedProfileFailure(
  agentDir: string,
  expectedError: RegExp,
  cfg: OpenClawConfig = createConfig(agentDir),
): Promise<void> {
  const createBrowserSession = vi.fn(async () => {
    throw new Error("unexpected realtime browser broker side effect");
  });
  const provider = buildOpenAIRealtimeVoiceProvider({
    quicksilverBrowserSessionBroker: {
      capabilities: { handlesAgentConsult: true },
      createBrowserSession,
      cancelBrowserSession: vi.fn(),
    },
  });
  await expect(
    provider.createBrowserSession?.({
      cfg,
      providerConfig: { model: MODEL },
      model: MODEL,
      agentId: "voice",
      workspaceDir: path.join(agentDir, "workspace"),
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    } as never),
  ).rejects.toThrow(expectedError);

  const bridge = provider.createBridge({
    cfg,
    agentId: "voice",
    providerConfig: { model: MODEL },
    runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  await expect(bridge.connect()).rejects.toThrow(expectedError);

  expect(createBrowserSession).not.toHaveBeenCalled();
  expect(sideEffects.webSocket).not.toHaveBeenCalled();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
}

describe("OpenAI realtime configured profile precedence", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    sideEffects.resolveSubscriptionAuth.mockReset();
    sideEffects.webSocket.mockClear();
  });

  it("fails closed for an explicitly selected missing profile before realtime side effects", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-realtime-auth-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
      saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used"); // pragma: allowlist secret
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unexpected realtime fetch side effect");
        }),
      );

      await expectSelectedProfileFailure(agentDir, /requires an OpenAI Platform API key/u);
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });

  it("fails closed for bare auth.order without profile metadata before realtime side effects", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-realtime-auth-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
      saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used"); // pragma: allowlist secret
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unexpected realtime fetch side effect");
        }),
      );

      await expectSelectedProfileFailure(agentDir, /requires an OpenAI Platform API key/u, {
        agents: { list: [{ id: "voice", agentDir }] },
        auth: { order: { openai: [PROFILE_ID] } },
      });
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });

  it("fails closed for an explicitly selected unresolved ref before realtime side effects", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-realtime-auth-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [PROFILE_ID]: {
              type: "api_key",
              provider: "openai",
              keyRef: {
                source: "env",
                provider: "default",
                id: "OPENAI_SELECTED_PROFILE_KEY",
              },
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      vi.stubEnv("OPENAI_SELECTED_PROFILE_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used"); // pragma: allowlist secret
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unexpected realtime fetch side effect");
        }),
      );

      await expectSelectedProfileFailure(agentDir, /configured but unavailable/u);
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });

  it("keeps explicit subscription OAuth ahead of an ambient Platform key", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-realtime-auth-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
      const access = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
      });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [PROFILE_ID]: {
              type: "oauth",
              provider: "openai",
              access,
              refresh: "refresh-token",
              expires: Date.now() + 60 * 60_000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used"); // pragma: allowlist secret
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unexpected realtime fetch side effect");
        }),
      );
      sideEffects.resolveSubscriptionAuth.mockResolvedValue({
        type: "oauth",
        token: access,
        accountId: "account-123",
      });
      const createBrowserSession = vi.fn(async () => ({
        provider: "openai",
        transport: "webrtc" as const,
        clientSecret: "subscription-session",
        offerUrl: "/plugins/openai/realtime/calls",
      }));
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: {
          capabilities: { handlesAgentConsult: true },
          createBrowserSession,
          cancelBrowserSession: vi.fn(),
        },
      });

      await provider.createBrowserSession?.({
        cfg: createConfig(agentDir, "oauth"),
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-realtime-2.1",
        agentId: "voice",
        workspaceDir: path.join(agentDir, "workspace"),
        initialItems: [],
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      } as never);

      expect(sideEffects.resolveSubscriptionAuth).toHaveBeenCalledWith({
        cfg: createConfig(agentDir, "oauth"),
        agentDir,
      });
      expect(createBrowserSession).toHaveBeenCalledWith(expect.any(Object), {
        type: "oauth",
        token: access,
        accountId: "account-123",
      });
      expect(sideEffects.webSocket).not.toHaveBeenCalled();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });
});
