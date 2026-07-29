/**
 * Tests OAuth refresh failure hints.
 * Verifies typed and message-based classification plus sanitized login command
 * generation.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { FailoverError } from "../failover-error.js";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  formatOAuthRefreshFailureLoginCommandMarkdown,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";

describe("oauth refresh failure hints", () => {
  it("builds OpenAI refresh-failure login hints", () => {
    expect(
      classifyOAuthRefreshFailure("OAuth token refresh failed for openai: invalid_grant"),
    ).toEqual({
      provider: "openai",
      reason: "invalid_grant",
    });
    expect(buildOAuthRefreshFailureLoginCommand("openai")).toBe(
      "openclaw models auth login --provider openai",
    );
  });

  it("includes the profile id in refresh-failure login hints when known", () => {
    expect(
      buildOAuthRefreshFailureLoginCommand("openai", {
        profileId: "Work Profile",
      }),
    ).toBe("openclaw models auth login --provider openai --profile-id 'Work Profile'");
  });

  it("renders login commands containing backticks as valid Markdown code spans", () => {
    const command = buildOAuthRefreshFailureLoginCommand("openai", {
      profileId: "openai:work`slot",
    });

    expect(formatOAuthRefreshFailureLoginCommandMarkdown(command)).toBe(
      "``openclaw models auth login --provider openai --profile-id 'openai:work`slot'``",
    );
  });

  it("classifies typed refresh failures without parsing the display message", () => {
    expect(
      classifyOAuthRefreshFailureError(
        new OAuthRefreshFailureError({
          provider: "openai",
          profileId: "openai:user@example.com",
          message: "invalid_grant",
        }),
      ),
    ).toEqual({
      provider: "openai",
      profileId: "openai:user@example.com",
      reason: "invalid_grant",
    });
  });

  it("classifies typed refresh failures through wrapper causes", () => {
    const refreshError = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: "openai:user@example.com",
      message: "invalid_grant",
    });

    expect(classifyOAuthRefreshFailureError(new Error("wrapped", { cause: refreshError }))).toEqual(
      {
        provider: "openai",
        profileId: "openai:user@example.com",
        reason: "invalid_grant",
      },
    );
  });

  it("classifies token invalidation refresh failures", () => {
    expect(
      classifyOAuthRefreshFailure(
        "OAuth token refresh failed for openai: token_invalidated. Please sign in again.",
      ),
    ).toEqual({
      provider: "openai",
      reason: "token_invalidated",
    });
  });

  it("classifies claude-cli subprocess 401 OAuth expiry as a provider refresh failure", () => {
    // Error message format emitted by the claude subprocess when its stored
    // OAuth token has expired, forwarded through the FailoverError message.
    const claudeCliFailureMessage =
      "Provider claude-cli failed: Failed to authenticate. API Error: 401 Invalid authentication credentials";
    expect(classifyOAuthRefreshFailure(claudeCliFailureMessage)).toEqual({
      provider: "claude-cli",
      reason: "revoked",
    });
    expect(buildOAuthRefreshFailureLoginCommand("claude-cli")).toBe(
      "claude auth login && openclaw models auth login --provider anthropic --method cli",
    );
  });

  it("classifies structured claude-cli 401 failures even when the display message omits the provider", () => {
    const error = new FailoverError(
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      {
        reason: "auth",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        status: 401,
      },
    );

    expect(classifyOAuthRefreshFailureError(error)).toEqual({
      provider: "claude-cli",
      reason: "revoked",
    });
  });

  it("classifies structured claude-cli logged-out failures without the provider prefix in the message", () => {
    const error = new FailoverError("Not logged in \u00b7 Please run /login", {
      reason: "auth",
      provider: "claude-cli",
      model: "claude-sonnet-4-20250514",
      status: 401,
    });

    expect(classifyOAuthRefreshFailureError(error)).toEqual({
      provider: "claude-cli",
      reason: "sign_in_again",
    });
  });

  it("does not classify a 401 auth failure without claude-cli prefix as a refresh failure", () => {
    // A generic 401 from another provider should NOT be treated as an OAuth
    // refresh failure — it lacks the "claude-cli" provider prefix.
    const otherProviderMessage =
      "Provider openai failed: Failed to authenticate. API Error: 401 Unauthorized";
    expect(classifyOAuthRefreshFailure(otherProviderMessage)).toBeNull();
  });
});

type LoopbackHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function withLoopbackServer<T>(
  handler: LoopbackHandler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function fetchClaudeCliOAuthProbe(baseUrl: string): Promise<{ ok: true; body: unknown }> {
  const response = await fetch(`${baseUrl}/oauth-expiry`);
  const body = await response.text();
  if (!response.ok) {
    const rawError = body.trim() || `HTTP ${response.status}`;
    const failure = new FailoverError(rawError, {
      reason: "auth",
      provider: "claude-cli",
      model: "claude-sonnet-4-20250514",
      status: response.status,
      rawError,
    });
    const oauthFailure =
      classifyOAuthRefreshFailureError(failure) ?? classifyOAuthRefreshFailure(failure.message);
    if (oauthFailure?.reason) {
      const command = buildOAuthRefreshFailureLoginCommand(oauthFailure.provider);
      throw new Error(
        `Model login expired on the gateway for ${oauthFailure.provider}. Re-auth with \`${command}\`, then try again.`,
        { cause: failure },
      );
    }
    throw failure;
  }
  return { ok: true, body: JSON.parse(body) };
}

describe("claude-cli oauth-expiry — real HTTP server (no fetch mock)", () => {
  it("throws a re-auth hint when the server returns 401", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("Failed to authenticate. API Error: 401 Invalid authentication credentials");
      },
      async (baseUrl) => {
        const error = await fetchClaudeCliOAuthProbe(baseUrl).then(
          () => undefined,
          (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
        );
        expect(error?.message).toContain(
          "Re-auth with `claude auth login && openclaw models auth login --provider anthropic --method cli`",
        );
        console.log(
          `[claude-cli-oauth-proof] server=401 → re-auth hint surfaced: ${error?.message}`,
        );
      },
    );
  });

  it("works normally when the server returns 200", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ provider: "claude-cli", ok: true }));
      },
      async (baseUrl) => {
        await expect(fetchClaudeCliOAuthProbe(baseUrl)).resolves.toEqual({
          ok: true,
          body: { provider: "claude-cli", ok: true },
        });
        console.log("[claude-cli-oauth-proof] server=200 → normal response returned");
      },
    );
  });
});
