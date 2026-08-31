// Tests elevated permission resolution from allowlists and message context.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

function buildConfig(allowFrom: string[]): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          whatsapp: allowFrom,
        },
      },
    },
  } as OpenClawConfig;
}

function buildContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderId: "+15550001111",
    From: "whatsapp:+15550001111",
    SenderE164: "+15550001111",
    To: "+15559990000",
    ...overrides,
  } as MsgContext;
}

function expectAllowFromDecision(params: {
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
}) {
  const result = resolveElevatedPermissions({
    cfg: buildConfig(params.allowFrom),
    agentId: "main",
    provider: "whatsapp",
    ctx: buildContext(params.ctx),
  });

  expect(result.enabled).toBe(true);
  expect(result.allowed).toBe(params.allowed);
  if (params.allowed) {
    expect(result.failures).toHaveLength(0);
    return;
  }

  expect(result.failures).toEqual([
    {
      gate: "allowFrom",
      key: "tools.elevated.allowFrom.whatsapp",
    },
  ]);
}

describe("resolveElevatedPermissions", () => {
  it("authorizes when sender matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15550001111"],
      allowed: true,
    });
  });

  it("does not authorize when only recipient matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15559990000"],
      allowed: false,
    });
  });

  it("does not authorize a group conversation id as a sender identity", () => {
    expectAllowFromDecision({
      allowFrom: ["120363411111111111@g.us", "from:120363411111111111@g.us"],
      allowed: false,
      ctx: {
        ChatType: "group",
        From: "120363411111111111@g.us",
        SenderId: "+15550002222",
        SenderE164: "+15550002222",
      },
    });
  });

  it("keeps direct chat From fallback authorization", () => {
    expectAllowFromDecision({
      allowFrom: ["from:whatsapp:+15550001111"],
      allowed: true,
      ctx: {
        ChatType: "direct",
        From: "whatsapp:+15550001111",
        SenderId: undefined,
        SenderE164: undefined,
      },
    });
  });

  it("does not authorize untyped mutable sender fields", () => {
    expectAllowFromDecision({
      allowFrom: ["owner-display-name"],
      allowed: false,
      ctx: {
        SenderName: "owner-display-name",
        SenderUsername: "owner-display-name",
        SenderTag: "owner-display-name",
      },
    });
  });

  it("authorizes mutable sender fields only with explicit prefix", () => {
    expectAllowFromDecision({
      allowFrom: ["username:owner_username"],
      allowed: true,
      ctx: {
        SenderUsername: "owner_username",
      },
    });
  });
});
