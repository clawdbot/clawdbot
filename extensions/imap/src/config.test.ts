import fs from "node:fs";
import type { IdentifierAuthentication } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it } from "vitest";
import { resolveImapConfig } from "./config.js";

it("accepts all SDK authentication strengths and rejects an unknown config minimum", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const strengths = [
    "mutable",
    "unverified",
    "asserted",
    "verified",
  ] satisfies IdentifierAuthentication[];
  for (const min of [...strengths, "unknown"]) {
    const value = {
      accounts: {
        inbox: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "fixture-password",
          agentId: "mail_reader",
          senderAuth: { min },
        },
      },
    };
    expect(
      validateJsonSchemaValue({
        schema: manifest.configSchema,
        cacheKey: "imap.manifest.config-schema",
        value,
      }).ok,
    ).toBe(min !== "unknown");
    if (min !== "unknown") {
      expect(resolveImapConfig(value).accounts.inbox?.senderAuth.min).toBe(min);
    }
  }
});

it.each([
  { deliver: true, delivery: { channel: "telegram", to: "chat-123" }, valid: true },
  { deliver: true, delivery: { channel: "telegram" }, valid: false },
  { deliver: true, delivery: { to: "chat-123" }, valid: false },
  { deliver: true, delivery: { channel: " ", to: "chat-123" }, valid: false },
  { deliver: true, delivery: undefined, valid: false },
  { deliver: false, delivery: undefined, valid: true },
])("validates complete delivery routes: $delivery", ({ deliver, delivery, valid }) => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const value = {
    accounts: {
      inbox: {
        host: "imap.example.com",
        user: "reader@example.com",
        password: "fixture-password",
        agentId: "mail_reader",
        deliver,
        ...(delivery ? { delivery } : {}),
      },
    },
  };

  expect(
    validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "imap.manifest.config-schema.delivery",
      value,
    }).ok,
  ).toBe(valid);
  if (valid) {
    expect(resolveImapConfig(value).accounts.inbox?.delivery).toEqual(delivery);
  }
});

it.each([
  ["missing", undefined],
  ["blank", { channel: " ", to: "chat-123" }],
] as const)("rejects a %s delivery route when delivery is enabled", (_label, delivery) => {
  expect(() =>
    resolveImapConfig({
      accounts: {
        inbox: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "fixture-password",
          agentId: "mail_reader",
          deliver: true,
          ...(delivery ? { delivery } : {}),
        },
      },
    }),
  ).toThrow("requires delivery.channel and delivery.to when deliver is true");
});
