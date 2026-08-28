import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  CODEX_HOST_INSPECTION_AUTH_ERROR,
  CODEX_NATIVE_EXECUTION_AUTH_ERROR,
} from "./command-authorization.js";
import { handleCodexSubcommand } from "./command-handlers.js";

function ctxFor(args: string, senderIsOwner: boolean): PluginCommandContext {
  return {
    args,
    senderIsOwner,
    gatewayClientScopes: undefined,
    config: {},
  } as unknown as PluginCommandContext;
}

async function replyFor(args: string, senderIsOwner: boolean): Promise<string> {
  const result = await handleCodexSubcommand(ctxFor(args, senderIsOwner), {
    deps: {} as never,
  });
  return typeof result.text === "string" ? result.text : "";
}

describe("codex host inspection gate", () => {
  // Every subcommand that reports host state is gated. `binding` reports the bound
  // workspace directory, the same class of value `sessions` reports through
  // `session.cwd` (node-cli-sessions.ts), so it belongs in the same set.
  it.each(["account", "binding", "mcp", "sessions", "skills", "status", "threads"])(
    "refuses /codex %s from a sender that is neither owner nor operator.admin",
    async (subcommand) => {
      await expect(replyFor(subcommand, false)).resolves.toBe(CODEX_HOST_INSPECTION_AUTH_ERROR);
    },
  );

  it("still refuses native control subcommands with their own message", async () => {
    await expect(replyFor("stop", false)).resolves.toBe(CODEX_NATIVE_EXECUTION_AUTH_ERROR);
  });

  it("leaves subcommands that report no host state open", async () => {
    await expect(replyFor("help", false)).resolves.not.toBe(CODEX_HOST_INSPECTION_AUTH_ERROR);
  });
});
