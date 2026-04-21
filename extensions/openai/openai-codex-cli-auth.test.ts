import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    debug: runtimeMocks.debug,
  }),
}));

import {
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
  readOpenAICodexCliOAuthProfile,
} from "./openai-codex-cli-auth.js";

function buildJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function mockCodexCliChatGptAuth(params?: {
  email?: string;
  accountId?: string;
  accessToken?: string;
}) {
  const accessToken =
    params?.accessToken ??
    buildJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/profile": {
        email: params?.email ?? "codex@example.com",
      },
    });
  vi.spyOn(fs, "readFileSync").mockReturnValue(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id-token",
        access_token: accessToken,
        refresh_token: "refresh-token",
        account_id: params?.accountId ?? "acct_123",
      },
    }),
  );
  return accessToken;
}

describe("readOpenAICodexCliOAuthProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads Codex CLI chatgpt auth into the default OpenAI Codex profile", () => {
    const accessToken = mockCodexCliChatGptAuth();

    const parsed = readOpenAICodexCliOAuthProfile({
      store: { version: 1, profiles: {} },
    });

    expect(parsed).toMatchObject({
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: accessToken,
        refresh: "refresh-token",
        accountId: "acct_123",
        idToken: "id-token",
        email: "codex@example.com",
      },
    });
    expect(parsed?.credential.expires).toBeGreaterThan(Date.now());
  });

  it("does not override a locally managed OpenAI Codex profile", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
    );

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
            type: "oauth",
            provider: "openai-codex",
            access: "local-access",
            refresh: "local-refresh",
            expires: Date.now() + 10 * 60_000,
          },
        },
      },
    });

    expect(parsed).toBeNull();
  });

  it("does not override explicit local non-oauth auth with Codex CLI bootstrap", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
    );

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-local",
          },
        },
      },
    });

    expect(parsed).toBeNull();
  });

  it("refuses Codex CLI bootstrap when an expired local default belongs to a different account", () => {
    mockCodexCliChatGptAuth({
      email: "codex-b@example.com",
      accountId: "acct_b",
    });

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
            type: "oauth",
            provider: "openai-codex",
            access: "near-expiry-local-access",
            refresh: "near-expiry-local-refresh",
            expires: Date.now() + 60_000,
            accountId: "acct_a",
            email: "codex-a@example.com",
          },
        },
      },
    });

    expect(parsed).toBeNull();
  });

  it("allows cli bootstrap when the stored default profile is expired", () => {
    const accessToken = mockCodexCliChatGptAuth();

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
            type: "oauth",
            provider: "openai-codex",
            access: "expired-local-access",
            refresh: "expired-local-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct_123",
          },
        },
      },
    });

    expect(parsed).toMatchObject({
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: {
        access: accessToken,
        refresh: "refresh-token",
        accountId: "acct_123",
        idToken: "id-token",
        email: "codex@example.com",
      },
    });
  });

  it("refuses cli bootstrap when the stored default profile is expired but identity mismatches", () => {
    mockCodexCliChatGptAuth();

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
            type: "oauth",
            provider: "openai-codex",
            access: "expired-local-access",
            refresh: "expired-local-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct_local",
          },
        },
      },
    });

    expect(parsed).toBeNull();
  });

  it("allows the runtime-only Codex CLI profile when the stored default already matches", () => {
    const accessToken = mockCodexCliChatGptAuth();

    const firstParse = readOpenAICodexCliOAuthProfile({
      store: { version: 1, profiles: {} },
    });
    expect(firstParse).not.toBeNull();

    const parsed = readOpenAICodexCliOAuthProfile({
      store: {
        version: 1,
        profiles: {
          [OPENAI_CODEX_DEFAULT_PROFILE_ID]: firstParse!.credential,
        },
      },
    });

    expect(parsed).toMatchObject({
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      credential: {
        access: accessToken,
        refresh: "refresh-token",
        accountId: "acct_123",
        idToken: "id-token",
        email: "codex@example.com",
      },
    });
  });

  it("returns null without logging when the Codex CLI auth file is missing", () => {
    const error = Object.assign(new Error("missing"), {
      code: "ENOENT",
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw error;
    });

    const parsed = readOpenAICodexCliOAuthProfile({
      store: { version: 1, profiles: {} },
    });

    expect(parsed).toBeNull();
    expect(runtimeMocks.debug).not.toHaveBeenCalled();
  });

  it("logs a sanitized code for invalid auth JSON", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{");

    const parsed = readOpenAICodexCliOAuthProfile({
      store: { version: 1, profiles: {} },
    });

    expect(parsed).toBeNull();
    expect(runtimeMocks.debug).toHaveBeenCalledWith(
      "Failed to read Codex CLI auth file (code=INVALID_JSON)",
    );
  });

  it("does not leak auth file paths in debug logs for filesystem failures", () => {
    const error = Object.assign(
      new Error("EACCES: permission denied, open '/Users/alice/.codex/auth.json'"),
      {
        code: "EACCES",
      },
    );
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw error;
    });

    const parsed = readOpenAICodexCliOAuthProfile({
      store: { version: 1, profiles: {} },
    });

    expect(parsed).toBeNull();
    expect(runtimeMocks.debug).toHaveBeenCalledWith(
      "Failed to read Codex CLI auth file (code=EACCES)",
    );
  });
});
