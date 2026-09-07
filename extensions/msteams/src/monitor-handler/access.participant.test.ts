import type { ResolveStableChannelMessageIngressParams } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveMSTeamsAccount, resolveMSTeamsDmPolicy } from "../channel-config.js";
import { installMSTeamsTestRuntime } from "../monitor-handler.test-helpers.js";
import { projectStableMSTeamsUserAllowlist } from "../resolve-allowlist.js";
import { resolveMSTeamsSenderAccess } from "./access.js";

const observed = vi.hoisted(() =>
  vi.fn<(params: ResolveStableChannelMessageIngressParams) => void>(),
);
vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>();
  return {
    ...actual,
    resolveStableChannelMessageIngress: (params: ResolveStableChannelMessageIngressParams) => {
      observed(params);
      return actual.resolveStableChannelMessageIngress(params);
    },
  };
});

describe("Teams participant domain", () => {
  it("keeps startup projection, audit identity, and inbound admission on one principal", async () => {
    installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
    const stableId = "40a1a0ed-4ff2-4164-a219-55518990c197";
    const authoredAllowFrom = [
      stableId.toUpperCase(),
      `user:${stableId}`,
      `teams:${stableId}`,
      `msteams:user:${stableId}`,
      `conversation:${stableId}`,
      ` teams:conversation:${stableId.toUpperCase()} `,
      `msteams:conversation:${stableId}`,
    ];
    const cfg = {
      channels: {
        msteams: {
          appId: "app-id",
          appPassword: "secret",
          dmPolicy: "allowlist" as const,
          allowFrom: authoredAllowFrom,
        },
      },
    };
    const projectedAllowFrom = projectStableMSTeamsUserAllowlist(authoredAllowFrom);
    const auditPolicy = resolveMSTeamsDmPolicy({
      cfg,
      account: resolveMSTeamsAccount(cfg),
    });
    const auditedPrincipals = new Set(
      authoredAllowFrom.map((entry) => auditPolicy.normalizeEntry?.(entry)),
    );

    expect(projectedAllowFrom).toEqual([stableId]);
    expect([...auditedPrincipals]).toEqual([stableId]);
    expect(
      authoredAllowFrom.map((entry) => auditPolicy.classifyEntryAuthentication?.(entry)),
    ).toEqual(authoredAllowFrom.map(() => "asserted"));

    const result = await resolveMSTeamsSenderAccess({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: projectedAllowFrom,
          },
        },
      },
      activity: {
        type: "message",
        id: "message",
        text: "hello",
        serviceUrl: "https://fixture.invalid",
        channelId: "msteams",
        from: { id: "opaque-account", aadObjectId: stableId.toUpperCase(), name: "Alice" },
        recipient: { id: "bot", name: "Bot" },
        conversation: { id: "conversation", conversationType: "personal" },
      },
    });

    expect(result.senderAccess.decision).toBe("allow");
    expect(result.senderAccess.effectiveAllowFrom).toEqual([stableId]);
  });

  it.each([
    ["bare", "40a1a0ed-4ff2-4164-a219-55518990c197", "allow"],
    ["user-prefixed", "user:40a1a0ed-4ff2-4164-a219-55518990c197", "allow"],
    ["provider-prefixed", "teams:40a1a0ed-4ff2-4164-a219-55518990c197", "allow"],
    ["provider-and-user-prefixed", "msteams:user:40a1a0ed-4ff2-4164-a219-55518990c197", "allow"],
    ["conversation-prefixed", "conversation:40a1a0ed-4ff2-4164-a219-55518990c197", "block"],
    [
      "provider-and-conversation-prefixed",
      "msteams:conversation:40a1a0ed-4ff2-4164-a219-55518990c197",
      "block",
    ],
  ] as const)(
    "applies a typed %s entry before message handling",
    async (_label, allowEntry, expected) => {
      installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
      const stableId = "40a1a0ed-4ff2-4164-a219-55518990c197";
      const result = await resolveMSTeamsSenderAccess({
        cfg: {
          channels: {
            msteams: {
              dmPolicy: "allowlist",
              allowFrom: [allowEntry],
            },
          },
        },
        activity: {
          type: "message",
          id: "message",
          text: "hello",
          serviceUrl: "https://fixture.invalid",
          channelId: "msteams",
          from: { id: "opaque-account", aadObjectId: stableId, name: "Alice" },
          recipient: { id: "bot", name: "Bot" },
          conversation: { id: "conversation", conversationType: "personal" },
        },
      });

      expect(result.senderAccess.decision).toBe(expected);
    },
  );

  it.each(["entra", "application", "unknown"] as const)(
    "retains %s identity evidence",
    async (kind) => {
      installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
      observed.mockClear();
      const activity = {
        type: "message",
        id: "message",
        text: "hello",
        serviceUrl: "https://fixture.invalid",
        channelId: "msteams",
        from: {
          id: "opaque-account",
          name: "Alice",
          ...(kind === "entra" ? { aadObjectId: "OBJECT-ID" } : {}),
        },
        recipient: { id: "bot", name: "Bot" },
        conversation: {
          id: "conversation",
          conversationType: "personal",
          ...(kind === "entra" ? { tenantId: "TENANT" } : {}),
        },
      };
      const result = await resolveMSTeamsSenderAccess({
        cfg: {
          channels: {
            msteams: {
              dmPolicy: "open",
              allowFrom: ["*"],
              ...(kind === "application" ? { appId: "APP" } : {}),
            },
          },
        },
        activity,
      });
      expect(result.senderAccess.allowed).toBe(true);
      const input = observed.mock.calls[0]?.[0];
      expect(input?.identity?.resolveParticipant?.(input.subject)).toEqual(
        kind === "entra"
          ? { domain: "entra:tenant", idKind: "object-id", id: "object-id" }
          : kind === "application"
            ? { domain: "bot:app", idKind: "channel-account-id", id: "opaque-account" }
            : undefined,
      );
    },
  );
});
