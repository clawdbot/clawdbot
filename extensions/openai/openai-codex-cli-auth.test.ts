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

describe("readOpenAICodexCliOAuthProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads Codex CLI chatgpt auth into the default OpenAI Codex profile", () => {
    const accessToken = buildJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      "https://api.openai.com/profile": {
        email: "codex@example.com",
      },
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
          account_id: "acct_123",
        },
      }),
    );

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
            expires: Date.now() + 60_000,
          },
        },
      },
    });

    expect(parsed).toBeNull();
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
