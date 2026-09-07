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
