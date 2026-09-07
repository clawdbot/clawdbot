import { describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import type { ChannelPlugin } from "../src/channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { collectChannelSecurityFindingsCore } from "../src/security/audit-channel.js";

vi.mock("../src/channels/message-access/store-allow-from.js", () => ({
  readChannelIngressStoreAllowFromForDmPolicy: async () => [],
}));

const msteamsAuditPlugin: ChannelPlugin = {
  id: msteamsPlugin.id,
  meta: msteamsPlugin.meta,
  capabilities: msteamsPlugin.capabilities,
  config: msteamsPlugin.config,
  security: msteamsPlugin.security,
};

const stableId = "40a1a0ed-4ff2-4164-a219-55518990c197";
const conversationEntries = [
  "conversation:a:1personal-chat",
  "teams:conversation:a:1personal-chat",
  "a:1personal-chat",
  "19:group@thread.tacv2",
  "msteams:conversation:19:legacy@thread.skype",
  "19:personal@unq.gbl.spaces",
  "8:orgid:opaque-account",
  "conversation:Alice Example",
];

describe.each([false, true])("Teams audit (name matching: %s)", (allowNameMatching) => {
  it.each([
    {
      name: "opaque conversations cannot unlock DMs or create routes",
      allowFrom: conversationEntries,
      locked: true,
      collision: false,
    },
    {
      name: "opaque conversations cannot add routes beside a stable sender",
      allowFrom: [stableId, ...conversationEntries],
      locked: false,
      collision: false,
    },
    {
      name: "legacy typed stable IDs still identify one admitted sender",
      allowFrom: [
        stableId,
        `conversation:${stableId}`,
        ` teams:conversation:${stableId.toUpperCase()} `,
        `msteams:user:${stableId}`,
      ],
      locked: false,
      collision: false,
    },
    {
      name: "distinct stable senders still expose shared-session collisions",
      allowFrom: [stableId, "0123456789abcdef"],
      locked: false,
      collision: true,
    },
    {
      name: "mutable names are only potential senders with explicit opt-in",
      allowFrom: ["Alice Example"],
      locked: !allowNameMatching,
      collision: false,
    },
  ])("$name", async ({ allowFrom, locked, collision }) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { dmScope: "main" },
      channels: {
        msteams: {
          authType: "secret",
          appId: "fixture-app",
          appPassword: "fixture-password",
          tenantId: "fixture-tenant",
          dmPolicy: "allowlist",
          allowFrom,
          dangerouslyAllowNameMatching: allowNameMatching,
        },
      },
    };
    const findings = await collectChannelSecurityFindingsCore({
      cfg,
      plugins: [msteamsAuditPlugin],
    });
    expect(findings.some((finding) => finding.checkId === "channels.msteams.dm.locked")).toBe(
      locked,
    );
    expect(findings.some((finding) => finding.checkId.includes(".dm.session_collision."))).toBe(
      collision,
    );
    expect(
      findings.some(
        (finding) => finding.checkId === "channels.msteams.allowFrom.mutable_entries_inert",
      ),
    ).toBe(!allowNameMatching && allowFrom.includes("Alice Example"));
  });
});
