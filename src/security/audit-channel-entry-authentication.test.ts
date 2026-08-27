import { discordPlugin } from "@openclaw/discord/api.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindingsCore } from "./audit-channel.js";

vi.mock("../channels/message-access/store-allow-from.js", () => ({
  readChannelIngressStoreAllowFromForDmPolicy: async () => ["stored-only#9999"],
}));

describe("channel entry authentication audit", () => {
  const auditPlugin = {
    id: discordPlugin.id,
    meta: discordPlugin.meta,
    capabilities: discordPlugin.capabilities,
    config: discordPlugin.config,
    security: discordPlugin.security,
  };
  const stableId = "123456789012345678";
  const tag = "alice#0001";
  const inertCheckId = "channels.discord.allowFrom.mutable_entries_inert";

  it.each([
    { name: "default policy", allowFrom: [tag, stableId], enabled: undefined, count: 1 },
    { name: "stable IDs only", allowFrom: [stableId], enabled: false, count: 0 },
    {
      name: "access group reference",
      allowFrom: ["accessGroup:operators"],
      enabled: false,
      count: 0,
    },
    {
      name: "access group preview",
      allowFrom: ["accessGroup:operators", tag],
      enabled: true,
      count: 1,
    },
    { name: "wildcard excluded", allowFrom: [tag, stableId, "*"], enabled: false, count: 1 },
    { name: "lockout preview", allowFrom: [tag, stableId], enabled: true, count: 1 },
    { name: "zero lockout preview", allowFrom: [stableId], enabled: true, count: 0 },
  ])("reports counts without identifiers: $name", async ({ allowFrom, enabled, count }) => {
    const cfg: OpenClawConfig = {
      accessGroups: { operators: { type: "message.senders", members: { discord: [stableId] } } },
      session: { dmScope: "per-account-channel-peer" },
      channels: {
        discord: {
          token: "test-token",
          groupPolicy: "disabled",
          dmPolicy: "pairing",
          allowFrom,
          dangerouslyAllowNameMatching: enabled,
        },
      },
    };
    const findings = await collectChannelSecurityFindingsCore({ cfg, plugins: [auditPlugin] });
    const inert = findings.find((finding) => finding.checkId === inertCheckId);
    if (!enabled && count > 0) {
      expect(inert).toMatchObject({ severity: "warn" });
      expect(inert?.detail).toContain("1 of 2 entries in channels.discord.allowFrom");
      expect(inert?.detail).toContain("silently inert");
    } else {
      expect(inert).toBeUndefined();
    }
    if (allowFrom.every((raw) => raw.startsWith("accessGroup:"))) {
      expect(findings.some((finding) => finding.checkId.endsWith("name_based_entries"))).toBe(
        false,
      );
    }
    if (enabled) {
      const preview = findings.find((finding) =>
        finding.checkId.endsWith("dangerous_name_matching_enabled"),
      );
      expect(preview?.detail).toContain(
        `${count} of ${allowFrom.length} allowFrom entries depend on mutable matching`,
      );
      expect(preview?.detail).toContain("mutable_identifier_disabled");
      expect(preview?.detail).toContain("identifier_authentication_too_weak");
    }
    const serialized = JSON.stringify(findings);
    for (const raw of [tag, stableId, "stored-only#9999"]) {
      expect(serialized).not.toContain(raw);
    }
  });

  it("uses the account policy and exposes inert entries to doctor", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          token: "test-token",
          dangerouslyAllowNameMatching: true,
          groupPolicy: "disabled",
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: [tag],
              dangerouslyAllowNameMatching: false,
            },
          },
        },
      },
    };
    const findings = await collectChannelSecurityFindingsCore({
      cfg,
      plugins: [auditPlugin],
      mode: "doctor",
    });
    expect(findings.find((finding) => finding.checkId === inertCheckId)).toMatchObject({
      severity: "warn",
      detail: expect.stringContaining("1 of 1 entries in channels.discord.accounts.work.allowFrom"),
    });
    expect(JSON.stringify(findings)).not.toContain(tag);
  });

  it("exposes Discord tag and snowflake strengths through resolveDmPolicy", () => {
    const cfg: OpenClawConfig = { channels: { discord: { token: "test-token" } } };
    const account = discordPlugin.config.resolveAccount(cfg, "default");
    const policy = discordPlugin.security?.resolveDmPolicy?.({
      cfg,
      accountId: "default",
      account,
    });
    expect(policy?.classifyEntryAuthentication?.(tag)).toBe("mutable");
    expect(policy?.classifyEntryAuthentication?.(stableId)).toBe("verified");
  });
});
