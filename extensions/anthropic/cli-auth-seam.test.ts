import { beforeEach, expect, it, vi } from "vitest";

const { readClaudeCliCredentialsCached } = vi.hoisted(() => ({
  readClaudeCliCredentialsCached: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  readClaudeCliCredentialsCached,
}));

const { readClaudeCliCredentialsForRuntime, readClaudeCliCredentialsForSetupNonInteractive } =
  await import("./cli-auth-seam.js");

beforeEach(() => {
  readClaudeCliCredentialsCached.mockReset();
});

it("keeps runtime Claude credential reads on the non-prompting path", () => {
  readClaudeCliCredentialsForRuntime();

  expect(readClaudeCliCredentialsCached).toHaveBeenCalledWith({ allowKeychainPrompt: false });
});

it("uses the bounded credential inspector only for non-interactive setup", () => {
  readClaudeCliCredentialsForSetupNonInteractive();

  expect(readClaudeCliCredentialsCached).toHaveBeenCalledWith(
    expect.objectContaining({
      allowKeychainPrompt: false,
      tryKeychainWithoutPrompt: true,
      ttlMs: 0,
      onStoredCredentialUnreadable: expect.any(Function),
    }),
  );
});
