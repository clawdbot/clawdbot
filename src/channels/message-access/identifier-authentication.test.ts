import { describe, expect, it } from "vitest";
import {
  meetsIdentifierAuthentication,
  weakestIdentifierAuthentication,
  type IdentifierAuthentication,
} from "./identifier-authentication.js";
import type { ResolveStableChannelMessageIngressParams } from "./runtime-types.js";
import { resolveStableChannelMessageIngress } from "./runtime.js";

const strengths: IdentifierAuthentication[] = ["mutable", "unverified", "asserted", "verified"];

function base(
  overrides: Partial<ResolveStableChannelMessageIngressParams> = {},
): ResolveStableChannelMessageIngressParams {
  return {
    channelId: "test",
    accountId: "default",
    subject: { stableId: "sender-1" },
    conversation: { kind: "direct", id: "dm-1" },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["sender-1"],
    ...overrides,
  };
}

describe("identifier authentication", () => {
  it("orders the scale and combines exact claims by the weaker strength", () => {
    for (const [actualIndex, actual] of strengths.entries()) {
      for (const [minimumIndex, minimum] of strengths.entries()) {
        expect(meetsIdentifierAuthentication(actual, minimum)).toBe(actualIndex >= minimumIndex);
        expect(weakestIdentifierAuthentication(actual, minimum)).toBe(
          strengths[Math.min(actualIndex, minimumIndex)],
        );
      }
    }
  });

  it("combines each matched entry with the exact same-kind subject identifier", async () => {
    const identity = {
      key: "primary-email",
      kind: "email" as const,
      authentication: "verified" as const,
      aliases: [
        {
          key: "secondary-email",
          kind: "email" as const,
          authentication: "verified" as const,
        },
      ],
    };
    const subject = {
      stableId: "strong@example.test",
      aliases: { "secondary-email": "weak@example.test" },
      authentication: {
        "primary-email": "verified" as const,
        "secondary-email": "unverified" as const,
      },
    };

    const strong = await resolveStableChannelMessageIngress(
      base({
        identity,
        subject,
        allowFrom: ["strong@example.test"],
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );
    const weak = await resolveStableChannelMessageIngress(
      base({
        identity,
        subject,
        allowFrom: ["weak@example.test"],
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(strong.senderAccess.allowed).toBe(true);
    expect(weak.senderAccess).toMatchObject({
      allowed: false,
      reasonCode: "dm_policy_not_allowlisted",
    });
    const pairs = strong.state.allowlists.dm.match.matchedPairs;
    expect(pairs).toHaveLength(1);
    expect(pairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opaqueSubjectId: "primary-email",
          subjectAuthentication: "verified",
        }),
      ]),
    );
    expect(pairs?.every((pair) => pair.opaqueSubjectId === "primary-email")).toBe(true);
    expect(JSON.stringify(strong.state)).not.toContain("strong@example.test");
    expect(JSON.stringify(weak.state)).not.toContain("weak@example.test");
  });

  it("does not cross-bind same-kind authentication between identity fields", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        identity: {
          key: "primary-email",
          kind: "email",
          authentication: "asserted",
          aliases: [{ key: "alias-email", kind: "email", authentication: "verified" }],
        },
        subject: {
          stableId: "shared@example.test",
          authentication: { "primary-email": "asserted" },
        },
        allowFrom: ["shared@example.test"],
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.senderAccess).toMatchObject({
      allowed: false,
      reasonCode: "dm_policy_not_allowlisted",
    });
    expect(result.state.allowlists.dm.match.matchedPairs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opaqueEntryId: "entry-1:alias-email",
          opaqueSubjectId: "primary-email",
        }),
      ]),
    );
    expect(JSON.stringify(result.state)).not.toContain("shared@example.test");
  });

  it("preserves the shipped dangerous and mutableIdentifierMatching mappings", async () => {
    const params = base({
      identity: { dangerous: true },
      subject: { stableId: "display-name" },
      allowFrom: ["display-name"],
    });
    const disabled = await resolveStableChannelMessageIngress(params);
    const enabled = await resolveStableChannelMessageIngress({
      ...params,
      policy: { mutableIdentifierMatching: "enabled" },
    });

    expect(disabled.senderAccess.allowed).toBe(false);
    expect(disabled.senderAccess.gate?.allowlist?.disabledEntryCount).toBeGreaterThan(0);
    expect(enabled.senderAccess.allowed).toBe(true);
  });

  it("floors an alias missing from a supplied authentication map to unverified", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        identity: {
          authentication: "verified",
          aliases: [{ key: "alias", authentication: "verified" }],
        },
        subject: {
          stableId: "sender-1",
          aliases: { alias: "alias-1" },
          authentication: { stableId: "verified" },
        },
        allowFrom: ["alias-1"],
      }),
    );

    expect(result.senderAccess.allowed).toBe(false);
    expect(result.state.allowlists.dm.match.matchedPairs).toEqual([
      {
        opaqueEntryId: "entry-1:alias",
        opaqueSubjectId: "alias",
        subjectAuthentication: "unverified",
      },
    ]);
  });

  it("preserves verified static strength when the authentication map is absent", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        identity: { authentication: "verified" },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.senderAccess.allowed).toBe(true);
    expect(result.state.allowlists.dm.match.matchedPairs).toEqual([
      {
        opaqueEntryId: "entry-1:stableId",
        opaqueSubjectId: "stableId",
        subjectAuthentication: "verified",
      },
    ]);
  });

  it.each(["disabled", "enabled"] as const)(
    "keeps mutable alias matching %s with only the primary claim supplied",
    async (mutableIdentifierMatching) => {
      const result = await resolveStableChannelMessageIngress(
        base({
          identity: {
            key: "member-id",
            aliases: [{ key: "display-name", kind: "username", dangerous: true }],
          },
          subject: {
            stableId: "member-1",
            aliases: { "display-name": "Echo" },
            authentication: { "member-id": "asserted" },
          },
          allowFrom: ["Echo"],
          policy: { mutableIdentifierMatching },
        }),
      );

      expect(result.senderAccess.allowed).toBe(mutableIdentifierMatching === "enabled");
    },
  );

  it("does not let a wildcard without an exact primary identifier claim verified", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        identity: { authentication: "verified" },
        subject: {},
        allowFrom: ["*"],
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.senderAccess).toMatchObject({
      allowed: false,
      reasonCode: "dm_policy_not_allowlisted",
    });
  });

  it.each([
    {
      name: "group sender",
      patch: {
        conversation: { kind: "group" as const, id: "room-1" },
        allowFrom: [],
        groupAllowFrom: ["sender-1"],
      },
      check: (result: Awaited<ReturnType<typeof resolveStableChannelMessageIngress>>) =>
        result.senderAccess.allowed,
    },
    {
      name: "command owner",
      patch: {
        command: {
          allowTextCommands: true,
          hasControlCommand: true,
          commandOwnerAllowFrom: ["sender-1"],
        },
      },
      check: (result: Awaited<ReturnType<typeof resolveStableChannelMessageIngress>>) =>
        result.commandAccess.authorized,
    },
    {
      name: "route sender",
      patch: {
        conversation: { kind: "group" as const, id: "room-1" },
        allowFrom: [],
        groupAllowFrom: ["other"],
        route: {
          id: "route-1",
          senderPolicy: "replace" as const,
          senderAllowFrom: ["sender-1"],
        },
      },
      check: (result: Awaited<ReturnType<typeof resolveStableChannelMessageIngress>>) =>
        result.routeAccess.allowed && result.senderAccess.allowed,
    },
  ])("applies the exact-pair threshold to $name gates", async ({ patch, check }) => {
    const common = {
      identity: { authentication: "verified" as const },
      subject: {
        stableId: "sender-1",
        authentication: { stableId: "unverified" as const },
      },
      policy: { minIdentifierAuthentication: "verified" as const },
    };
    const result = await resolveStableChannelMessageIngress(base({ ...patch, ...common }));
    expect(check(result)).toBe(false);
  });

  it("preserves exact-pair authentication through inherited route lists", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        conversation: { kind: "group", id: "room-1" },
        identity: { authentication: "verified" },
        subject: {
          stableId: "sender-1",
          authentication: { stableId: "unverified" },
        },
        allowFrom: [],
        groupAllowFrom: ["other"],
        route: {
          id: "route-1",
          senderPolicy: "inherit",
          senderAllowFrom: ["sender-1"],
        },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.routeAccess.allowed).toBe(true);
    expect(result.senderAccess).toMatchObject({
      allowed: false,
      reasonCode: "group_policy_not_allowlisted",
      gate: {
        identifierAuthentication: { evaluated: true, affectedMatch: true },
      },
    });
    expect(JSON.stringify(result.state)).not.toContain("sender-1");
  });

  it("namespaces exact pairs from inherited route lists", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        conversation: { kind: "group", id: "room-1" },
        identity: {
          authentication: (value) => (value === "sender-1" ? "verified" : "asserted"),
        },
        subject: {
          stableId: "sender-1",
          authentication: { stableId: "verified" },
        },
        allowFrom: [],
        groupAllowFrom: ["other"],
        route: {
          id: "route-1",
          senderPolicy: "inherit",
          senderAllowFrom: ["sender-1"],
        },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.senderAccess).toMatchObject({
      allowed: true,
      reasonCode: "group_policy_allowed",
    });
    expect(result.senderAccess.gate?.match?.matchedEntryIds).toEqual(["source-2:entry-1:stableId"]);
  });

  it("does not cross-bind same-kind origin-subject fields", async () => {
    const result = await resolveStableChannelMessageIngress(
      base({
        identity: {
          key: "primary-email",
          kind: "email",
          aliases: [{ key: "alias-email", kind: "email" }],
        },
        subject: {
          stableId: "shared@example.test",
          authentication: { "primary-email": "verified" },
        },
        event: {
          kind: "reaction",
          authMode: "origin-subject",
          mayPair: false,
          originSubject: {
            identifiers: [
              {
                opaqueId: "alias-email",
                kind: "email",
                value: "shared@example.test",
                authentication: "verified",
              },
            ],
          },
        },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.ingress).toMatchObject({
      admission: "drop",
      reasonCode: "origin_subject_not_matched",
    });
    expect(JSON.stringify(result.state)).not.toContain("shared@example.test");
  });

  it("applies the threshold to access-group and origin-subject gates", async () => {
    const accessGroup = await resolveStableChannelMessageIngress(
      base({
        identity: { authentication: "verified" },
        subject: {
          stableId: "sender-1",
          authentication: { stableId: "unverified" },
        },
        allowFrom: ["accessGroup:operators"],
        accessGroups: {
          operators: { type: "message.senders", members: { test: ["sender-1"] } },
        },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );
    const origin = await resolveStableChannelMessageIngress(
      base({
        identity: { authentication: "verified" },
        subject: {
          stableId: "sender-1",
          authentication: { stableId: "unverified" },
        },
        event: {
          kind: "reaction",
          authMode: "origin-subject",
          mayPair: false,
          originSubject: {
            identifiers: [
              {
                opaqueId: "origin-stable",
                kind: "stable-id",
                value: "sender-1",
                authentication: "verified",
              },
            ],
          },
        },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(accessGroup.senderAccess.allowed).toBe(false);
    expect(origin.ingress).toMatchObject({
      admission: "drop",
      reasonCode: "origin_subject_not_matched",
    });
  });

  it.each([
    {
      name: "runtime resolver",
      patch: {
        resolveAccessGroupMembership: async () => true,
      },
    },
    {
      name: "precomputed membership",
      patch: {
        accessGroupMembership: [
          {
            kind: "matched" as const,
            groupName: "audience",
            source: "dynamic" as const,
            matchedEntryIds: ["access-group:audience"],
          },
        ],
      },
    },
  ])("fails $name access-group matches closed at a verified minimum", async ({ patch }) => {
    const result = await resolveStableChannelMessageIngress(
      base({
        ...patch,
        allowFrom: ["accessGroup:audience"],
        accessGroups: {
          audience: {
            type: "discord.channelAudience",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        },
        policy: { minIdentifierAuthentication: "verified" },
      }),
    );

    expect(result.senderAccess).toMatchObject({
      allowed: false,
      reasonCode: "dm_policy_not_allowlisted",
      gate: {
        identifierAuthentication: { evaluated: true, affectedMatch: true },
      },
    });
  });
});
