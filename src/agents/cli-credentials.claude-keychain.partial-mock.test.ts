/**
 * Loading the Keychain module must not read node:child_process exports.
 *
 * Suites elsewhere in the repo mock node:child_process with only the export
 * they use, so any export this module touches at load time throws while that
 * unrelated suite is merely resolving its imports.
 */
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("loads under a partial node:child_process mock that omits execFile", async () => {
  const keychain = await import("./cli-credentials.claude-keychain.js");
  expect(typeof keychain.readClaudeCliKeychainPayloadAsync).toBe("function");
});
