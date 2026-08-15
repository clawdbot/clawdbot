/** Tests command authorization owner defaults for direct-message senders. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveOwnerPromptNumbers } from "../agents/owner-display.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

describe("senderIsOwner only reflects explicit owner authorization", () => {
  it("does not treat direct-message senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not treat group-chat senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("keeps channel-validated native group commands authorized without owner status", () => {
    const cfg = {
      channels: { telegram: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SenderId: "200482621",
      CommandSource: "native",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("keeps channel allowlist senders authorized without owner status", () => {
    const cfg = {
      channels: { telegram: { allowFrom: ["200482621"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:200482621",
      SenderId: "200482621",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.ownerList).toEqual([]);
    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("senderIsOwner is false when ownerAllowFrom is configured and sender does not match", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:789",
      SenderId: "789",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not let native command authorization bypass explicit owner allowlists", () => {
    const cfg = {
      channels: { telegram: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SenderId: "200482621",
      CommandSource: "native",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
  });

  it("senderIsOwner is true when ownerAllowFrom matches sender", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:456",
      SenderId: "456",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
  });

  it("keeps a large owner allowlist authorized without exhausting the model prompt", () => {
    const ownerIds = Array.from({ length: 9_282 }, (_, index) =>
      String(100_000_000_000_000_000n + BigInt(index)),
    );
    const currentOwnerId = ownerIds.at(-1)!;
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ownerIds.map((ownerId) => `discord:${ownerId}`) },
    } as OpenClawConfig;
    const context = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${currentOwnerId}`,
      SenderId: `<@!${currentOwnerId}>`,
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: context,
    });

    expect(auth.ownerList).toHaveLength(ownerIds.length);
    expect(auth.senderId).toBe(currentOwnerId);
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);

    const ownerNumbers = resolveOwnerPromptNumbers({
      ownerNumbers: auth.ownerList,
      senderId: auth.senderId,
      senderIsOwner: auth.senderIsOwner,
    });
    const promptParams = {
      workspaceDir: "/tmp/openclaw",
      ownerNumbers,
      runtimeInfo: { channel: "discord" },
    };
    const prompt = buildAgentSystemPrompt(promptParams);
    const ownerLine = prompt.split("## Authorized Senders\n")[1]?.split("\n")[0] ?? "";

    expect(ownerLine).toContain(currentOwnerId);
    expect(Buffer.byteLength(ownerLine, "utf8")).toBeLessThanOrEqual(1_024);

    const hashedPrompt = buildAgentSystemPrompt({ ...promptParams, ownerDisplay: "hash" });
    const currentOwnerHash = createHash("sha256").update(currentOwnerId).digest("hex").slice(0, 12);
    expect(hashedPrompt).toContain(currentOwnerHash);
    expect(hashedPrompt).not.toContain(currentOwnerId);

    cfg.commands?.ownerAllowFrom?.pop();
    const revoked = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: context,
    });
    expect(revoked.ownerList).toHaveLength(ownerIds.length - 1);
    expect(revoked.senderIsOwner).toBe(false);
    expect(revoked.isAuthorizedSender).toBe(false);
  });

  it("ignores ownerAllowFrom wildcards", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["*"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:anyone",
      SenderId: "anyone",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.ownerList).toEqual([]);
    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("senderIsOwner is true for internal operator.admin sessions", () => {
    const cfg = {} as OpenClawConfig;

    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.admin"],
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
  });
});
