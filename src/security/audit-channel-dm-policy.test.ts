// Covers direct-message policy audit findings for channels.
import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

type ChannelSecurityFinding = Awaited<ReturnType<typeof collectChannelSecurityFindings>>[number];

function requireFinding(
  findings: ChannelSecurityFinding[],
  checkId: string,
): ChannelSecurityFinding {
  const finding = findings.find((entry) => entry.checkId === checkId);
  if (!finding) {
    throw new Error(`Expected finding ${checkId}`);
  }
  return finding;
}

function collisionFindings(findings: ChannelSecurityFinding[]): ChannelSecurityFinding[] {
  return findings.filter((finding) => finding.checkId.includes(".dm.session_collision."));
}

function createDmPlugin(
  params: {
    id?: "telegram" | "whatsapp";
    accounts?: Record<string, { policy?: string; allowFrom: Array<string | number> }>;
    dmRouting?: NonNullable<ChannelPlugin["security"]>["dmRouting"];
  } = {},
): ChannelPlugin {
  const id = params.id ?? "whatsapp";
  const accounts = params.accounts ?? {
    default: { policy: "allowlist", allowFrom: ["user-a", "user-b"] },
  };
  const accountIds = Object.keys(accounts);
  const security: NonNullable<ChannelPlugin["security"]> = {
    resolveDmPolicy: ({ accountId }: { accountId?: string | null }) => {
      const resolvedAccountId = accountId ?? "default";
      const policy = accounts[resolvedAccountId];
      return policy
        ? {
            policy: policy.policy ?? "allowlist",
            allowFrom: policy.allowFrom,
            policyPath: `channels.${id}.accounts.${resolvedAccountId}.dmPolicy`,
            allowFromPath: `channels.${id}.accounts.${resolvedAccountId}.`,
            approveHint: `approve ${resolvedAccountId}`,
          }
        : null;
    },
    ...(params.dmRouting ? { dmRouting: params.dmRouting } : {}),
  };

  const label = id === "telegram" ? "Telegram" : "WhatsApp";
  return {
    id,
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: `/channels/${id}`,
      blurb: "Test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => accountIds,
      defaultAccountId: () => accountIds[0] ?? "default",
      inspectAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        enabled: true,
        configured: true,
      }),
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    security,
  };
}

describe("security audit channel dm policy", () => {
  it.each([
    {
      name: "global main + winning isolated binding is safe",
      cfg: {
        session: { dmScope: "main" },
        bindings: [
          {
            agentId: "main",
            match: { channel: "whatsapp", peer: { kind: "direct", id: "*" } },
            session: { dmScope: "per-channel-peer" },
          },
        ],
      } satisfies OpenClawConfig,
      expectedCollisions: 0,
    },
    {
      name: "global isolated + winning main binding collides",
      cfg: {
        session: { dmScope: "per-channel-peer" },
        bindings: [
          {
            agentId: "main",
            match: { channel: "whatsapp", peer: { kind: "direct", id: "*" } },
            session: { dmScope: "main" },
          },
        ],
      } satisfies OpenClawConfig,
      expectedCollisions: 1,
      remediation: "matching binding or session.dmScope",
    },
    {
      name: "exact peer bindings outrank a colliding channel binding",
      cfg: {
        session: { dmScope: "main" },
        bindings: [
          {
            agentId: "main",
            match: { channel: "whatsapp" },
            session: { dmScope: "main" },
          },
          {
            agentId: "main",
            match: { channel: "whatsapp", peer: { kind: "direct", id: "user-a" } },
            session: { dmScope: "per-channel-peer" },
          },
          {
            agentId: "main",
            match: { channel: "whatsapp", peer: { kind: "direct", id: "user-b" } },
            session: { dmScope: "per-channel-peer" },
          },
        ],
      } satisfies OpenClawConfig,
      expectedCollisions: 0,
    },
    {
      name: "global session aliases remain isolated by routed agent store",
      cfg: {
        agents: { list: [{ id: "agent-a" }, { id: "agent-b", default: true }] },
        session: { scope: "global", dmScope: "main" },
        bindings: [
          {
            agentId: "agent-a",
            match: { channel: "whatsapp", peer: { kind: "direct", id: "user-a" } },
          },
          {
            agentId: "agent-b",
            match: { channel: "whatsapp", peer: { kind: "direct", id: "user-b" } },
          },
        ],
      } satisfies OpenClawConfig,
      expectedCollisions: 0,
    },
  ])("$name", async ({ cfg, expectedCollisions, remediation }) => {
    const findings = await collectChannelSecurityFindings({
      cfg,
      plugins: [createDmPlugin()],
    });

    const collisions = collisionFindings(findings);
    expect(collisions).toHaveLength(expectedCollisions);
    if (remediation) {
      expect(collisions[0]?.remediation).toContain(remediation);
    }
  });

  it("detects cross-account collisions with one admitted sender per account", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin({
          accounts: {
            "Personal Account": { allowFrom: ["user-a"] },
            "work@example": { allowFrom: ["user-b"] },
          },
        }),
      ],
    });

    const collisions = collisionFindings(findings);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.checkId).toContain("whatsapp-personal-account_whatsapp-work-example");
    expect(collisions[0]?.checkId).toMatch(/^[a-z0-9._-]+$/);
    expect(collisions[0]?.detail).toContain("personal-account");
    expect(collisions[0]?.detail).toContain("work-example");
  });

  it("keeps same-named accounts attributed across channels", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin({ accounts: { default: { allowFrom: ["user-a"] } } }),
        createDmPlugin({
          id: "telegram",
          accounts: { default: { allowFrom: ["user-b"] } },
        }),
      ],
    });

    const collision = collisionFindings(findings)[0];
    expect(collision?.checkId).toContain("telegram-default_whatsapp-default");
    expect(collision?.detail).toContain("telegram-default, whatsapp-default");
  });

  it("counts identity-linked aliases as one logical principal", async () => {
    const cfg: OpenClawConfig = {
      session: {
        dmScope: "main",
        identityLinks: { alice: ["whatsapp:user-a", "whatsapp:user-b"] },
      },
    };
    const plugin = createDmPlugin();

    const linkedFindings = await collectChannelSecurityFindings({ cfg, plugins: [plugin] });
    const distinctFindings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [plugin],
    });

    expect(collisionFindings(linkedFindings)).toHaveLength(0);
    expect(collisionFindings(distinctFindings)).toHaveLength(1);
  });

  it("keeps separate collision topologies distinct", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: {
        agents: { list: [{ id: "alpha", default: true }, { id: "beta" }] },
        session: { dmScope: "main" },
        bindings: [
          { agentId: "alpha", match: { channel: "whatsapp", accountId: "a" } },
          { agentId: "alpha", match: { channel: "whatsapp", accountId: "b" } },
          { agentId: "beta", match: { channel: "whatsapp", accountId: "c" } },
          { agentId: "beta", match: { channel: "whatsapp", accountId: "d" } },
        ],
      },
      plugins: [
        createDmPlugin({
          accounts: {
            a: { allowFrom: ["user-a"] },
            b: { allowFrom: ["user-b"] },
            c: { allowFrom: ["user-c"] },
            d: { allowFrom: ["user-d"] },
          },
        }),
      ],
    });

    const collisions = collisionFindings(findings);
    expect(collisions).toHaveLength(2);
    expect(new Set(collisions.map((finding) => finding.checkId)).size).toBe(2);
    expect(new Set(collisions.map((finding) => finding.detail)).size).toBe(2);
  });

  it("uses the channel-owned DM route for wildcard senders", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin({
          accounts: { default: { policy: "open", allowFrom: ["*"] } },
          dmRouting: { resolveDmScope: () => "per-channel-peer" },
        }),
      ],
    });

    expect(collisionFindings(findings)).toHaveLength(0);
  });

  it.each([
    {
      name: "per-channel-peer collides across accounts",
      dmScope: "per-channel-peer" as const,
      plugins: () => [
        createDmPlugin({
          accounts: {
            personal: { policy: "open", allowFrom: ["*"] },
            work: { policy: "open", allowFrom: ["*"] },
          },
        }),
      ],
      expectedCollisions: 1,
    },
    {
      name: "per-peer collides across channels",
      dmScope: "per-peer" as const,
      plugins: () => [
        createDmPlugin({ accounts: { default: { policy: "open", allowFrom: ["*"] } } }),
        createDmPlugin({
          id: "telegram",
          accounts: { default: { policy: "open", allowFrom: ["*"] } },
        }),
      ],
      expectedCollisions: 1,
    },
    {
      name: "per-account-channel-peer stays isolated",
      dmScope: "per-account-channel-peer" as const,
      plugins: () => [
        createDmPlugin({
          accounts: {
            personal: { policy: "open", allowFrom: ["*"] },
            work: { policy: "open", allowFrom: ["*"] },
          },
        }),
      ],
      expectedCollisions: 0,
    },
  ])("models wildcard namespace: $name", async ({ dmScope, plugins, expectedCollisions }) => {
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope } },
      plugins: plugins(),
    });
    const collisions = collisionFindings(findings);

    expect(collisions).toHaveLength(expectedCollisions);
    if (expectedCollisions > 0) {
      expect(collisions[0]?.detail).toContain("can resolve to the same session bucket");
    }
  });

  it.each([
    {
      name: "per-channel wildcard intersects a concrete sender on the same channel",
      cfg: { session: { dmScope: "per-channel-peer" as const } },
      plugins: [
        createDmPlugin({
          accounts: {
            open: { policy: "open", allowFrom: ["*"] },
            finite: { allowFrom: ["user-b"] },
          },
          dmRouting: {
            resolveDmRoute: ({ principalId }) =>
              principalId === undefined ? { kind: "core" } : undefined,
          },
        }),
      ],
      expectedCollisions: 1,
    },
    {
      name: "per-peer wildcard intersects a concrete sender on another channel",
      cfg: { session: { dmScope: "per-peer" as const } },
      plugins: [
        createDmPlugin({ accounts: { open: { policy: "open", allowFrom: ["*"] } } }),
        createDmPlugin({
          id: "telegram",
          accounts: { finite: { allowFrom: ["user-b"] } },
        }),
      ],
      expectedCollisions: 1,
    },
    {
      name: "per-channel wildcards on different channels stay separate",
      cfg: { session: { dmScope: "per-channel-peer" as const } },
      plugins: [
        createDmPlugin({ accounts: { open: { policy: "open", allowFrom: ["*"] } } }),
        createDmPlugin({
          id: "telegram",
          accounts: { open: { policy: "open", allowFrom: ["*"] } },
        }),
      ],
      expectedCollisions: 0,
    },
    {
      name: "per-peer wildcard subsumes an overlapping per-channel wildcard",
      cfg: {},
      plugins: [
        createDmPlugin({
          accounts: { open: { policy: "open", allowFrom: ["*"] } },
          dmRouting: { resolveDmScope: () => "per-peer" },
        }),
        createDmPlugin({
          id: "telegram",
          accounts: { open: { policy: "open", allowFrom: ["*"] } },
          dmRouting: { resolveDmScope: () => "per-channel-peer" },
        }),
      ],
      expectedCollisions: 1,
    },
  ])("intersects wildcard namespace: $name", async ({ cfg, plugins, expectedCollisions }) => {
    const findings = await collectChannelSecurityFindings({ cfg, plugins });
    const collisions = collisionFindings(findings);

    expect(collisions).toHaveLength(expectedCollisions);
    for (const collision of collisions) {
      expect(collision.title).toContain("may share");
      expect(collision.detail).toContain("can resolve to the same session bucket");
    }
  });

  it("does not let exact bindings on finite probe strings hide an open-DM collision", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: {
        session: { dmScope: "main" },
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "whatsapp",
              peer: { kind: "direct", id: "__openclaw_audit_unmatched_dm_1__" },
            },
            session: { dmScope: "per-channel-peer" },
          },
          {
            agentId: "main",
            match: {
              channel: "whatsapp",
              peer: { kind: "direct", id: "__openclaw_audit_unmatched_dm_2__" },
            },
            session: { dmScope: "per-channel-peer" },
          },
        ],
      },
      plugins: [
        createDmPlugin({
          accounts: { default: { policy: "open", allowFrom: ["*"] } },
        }),
      ],
    });

    expect(collisionFindings(findings)).toHaveLength(1);
  });

  it("audits exact DM bindings admitted by wildcard policy", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: {
        session: { dmScope: "per-account-channel-peer" },
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "whatsapp",
              accountId: "*",
              peer: { kind: "direct", id: "bound-a" },
            },
            session: { dmScope: "main" },
          },
          {
            agentId: "main",
            match: {
              channel: "whatsapp",
              accountId: " WORK ",
              peer: { kind: "direct", id: "bound-b" },
            },
            session: { dmScope: "main" },
          },
        ],
      },
      plugins: [
        createDmPlugin({
          accounts: { work: { policy: "open", allowFrom: ["*"] } },
        }),
      ],
    });

    const collisions = collisionFindings(findings);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.title).toBe("DM principals share a session");
    expect(collisions[0]?.detail).toContain("2 distinct admitted DM principals");
  });

  it("does not invoke finite session routing for wildcard analysis", async () => {
    const resolveDmRoute = vi.fn(({ principalId, route }) => {
      if (principalId === undefined) {
        return { kind: "isolated" as const };
      }
      if (!/^\d+$/.test(principalId)) {
        throw new Error("principal must be numeric");
      }
      return { sessionKey: route.sessionKey };
    });
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin({
          accounts: { default: { policy: "open", allowFrom: ["*"] } },
          dmRouting: { resolveDmRoute },
        }),
      ],
    });

    expect(resolveDmRoute).toHaveBeenCalledOnce();
    expect(resolveDmRoute.mock.calls[0]?.[0].principalId).toBeUndefined();
    expect(collisionFindings(findings)).toHaveLength(0);
  });

  it("warns when custom finite routing omits an unknown-principal policy", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin({
          accounts: { default: { policy: "open", allowFrom: ["*"] } },
          dmRouting: {
            resolveDmRoute: ({ principalId, route }) =>
              principalId === undefined ? undefined : { sessionKey: route.sessionKey },
          },
        }),
      ],
    });

    const finding = requireFinding(
      findings,
      "channels.whatsapp.dm.wildcard_routing_unverified.default",
    );
    expect(finding.detail).toContain("resolveDmRoute returned no unknown-principal policy");
  });

  it("flags public DMs and shared session ownership together", async () => {
    const findings = await collectChannelSecurityFindings({
      cfg: { session: { dmScope: "main" } },
      plugins: [
        createDmPlugin({
          accounts: { default: { policy: "open", allowFrom: ["*"] } },
        }),
      ],
    });

    expect(requireFinding(findings, "channels.whatsapp.dm.open").severity).toBe("critical");
    expect(collisionFindings(findings)).toHaveLength(1);
  });
});
