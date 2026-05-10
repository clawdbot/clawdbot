/**
 * Regression tests for QQBot command authorization alignment with the shared
 * command-auth model.
 *
 * Covers the regression identified in the code review:
 *
 *   allowFrom entries with the qqbot: prefix must normalize correctly so that
 *   "qqbot:<id>" in channel.allowFrom matches the inbound event.senderId "<id>".
 *   Verified against the normalization logic in the gateway.ts inbound path.
 *
 * Note: framework command authorization precedence is covered by the
 * framework's own tests rather than duplicated here.
 */

import { describe, expect, it } from "vitest";
import { createSdkAccessAdapter } from "./bridge/sdk-adapter.js";

// ---------------------------------------------------------------------------
// qqbot: prefix normalization for inbound commandAuthorized
//
// Uses qqbotPlugin.config.formatAllowFrom directly — the same function the
// fixed gateway.ts inbound path calls — so the test stays in sync with the
// actual implementation without duplicating the logic.
// ---------------------------------------------------------------------------

describe("qqbot: prefix normalization for inbound commandAuthorized", () => {
  const access = createSdkAccessAdapter();

  async function resolveInboundCommandAuthorized(
    rawAllowFrom: string[],
    senderId: string,
    options: {
      isGroup?: boolean;
      groupAllowFrom?: string[];
    } = {},
  ): Promise<boolean> {
    const result = await access.resolveInboundAccess({
      cfg: {},
      accountId: "default",
      conversationId: options.isGroup ? "group-openid" : senderId,
      isGroup: options.isGroup ?? false,
      senderId,
      allowFrom: rawAllowFrom,
      groupAllowFrom: options.groupAllowFrom,
    });
    return result.commandAccess.authorized;
  }

  it("authorizes when allowFrom uses qqbot: prefix and senderId is the bare id", async () => {
    await expect(resolveInboundCommandAuthorized(["qqbot:USER123"], "USER123")).resolves.toBe(true);
  });

  it("authorizes when qqbot: prefix is mixed case", async () => {
    await expect(resolveInboundCommandAuthorized(["QQBot:user123"], "USER123")).resolves.toBe(true);
  });

  it("denies a sender not in the qqbot:-prefixed allowFrom list", async () => {
    await expect(resolveInboundCommandAuthorized(["qqbot:USER123"], "OTHER")).resolves.toBe(false);
  });

  it("authorizes any sender when allowFrom is empty (open)", async () => {
    await expect(resolveInboundCommandAuthorized([], "ANYONE")).resolves.toBe(true);
  });

  it("authorizes any sender when allowFrom contains wildcard *", async () => {
    await expect(resolveInboundCommandAuthorized(["*"], "ANYONE")).resolves.toBe(true);
  });

  it("denies group command auth in an open group without explicit allowlists", async () => {
    await expect(resolveInboundCommandAuthorized([], "ANYONE", { isGroup: true })).resolves.toBe(
      false,
    );
  });

  it("authorizes group command auth for an explicit group allowlist sender", async () => {
    await expect(
      resolveInboundCommandAuthorized([], "GROUP_OWNER", {
        isGroup: true,
        groupAllowFrom: ["qqbot:GROUP_OWNER"],
      }),
    ).resolves.toBe(true);
  });
});
