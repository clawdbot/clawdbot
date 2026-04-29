import { describe, expect, it } from "vitest";
import {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmAllowState,
  resolveDmGroupAccessWithCommandGate,
  resolveDmGroupAccessDecision,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "./dm-policy-shared.js";

describe("security/dm-policy-shared", () => {
  const controlCommand = {
    useAccessGroups: true,
    allowTextCommands: true,
    hasControlCommand: true,
  } as const;

  async function expectStoreReadSkipped(params: {
    provider: string;
    accountId: string;
    dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
    shouldRead?: boolean;
  }) {
    let called = false;
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: params.provider,
      accountId: params.accountId,
      ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
      ...(params.shouldRead !== undefined ? { shouldRead: params.shouldRead } : {}),
      readStore: async (_provider, _accountId) => {
        called = true;
        return ["should-not-be-read"];
      },
    });
    expect(called).toBe(false);
    expect(storeAllowFrom).toEqual([]);
  }

  function resolveCommandGate(overrides: {
    isGroup: boolean;
    isSenderAllowed: (allowFrom: string[]) => boolean;
    groupPolicy?: "open" | "allowlist" | "disabled";
  }) {
    return resolveDmGroupAccessWithCommandGate({
      dmPolicy: "pairing",
      groupPolicy: overrides.groupPolicy ?? "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: ["group-owner"],
      storeAllowFrom: ["paired-user"],
      command: controlCommand,
      ...overrides,
    });
  }

  it("normalizes config + store allow entries and counts distinct senders", async () => {
    const state = await resolveDmAllowState({
      provider: "demo-channel-a" as never,
      accountId: "default",
      allowFrom: [" * ", " alice ", "ALICE", "bob"],
      normalizeEntry: (value) => value.toLowerCase(),
      readStore: async (_provider, _accountId) => [" Bob ", "carol", ""],
    });
    expect(state.configAllowFrom).toEqual(["*", "alice", "ALICE", "bob"]);
    expect(state.hasWildcard).toBe(true);
    expect(state.allowCount).toBe(3);
    expect(state.isMultiUserDm).toBe(true);
  });

  it("handles empty allowlists and store failures", async () => {
    const state = await resolveDmAllowState({
      provider: "demo-channel-b" as never,
      accountId: "default",
      allowFrom: undefined,
      readStore: async (_provider, _accountId) => {
        throw new Error("offline");
      },
    });
    expect(state.configAllowFrom).toEqual([]);
    expect(state.hasWildcard).toBe(false);
    expect(state.allowCount).toBe(0);
    expect(state.isMultiUserDm).toBe(false);
  });

  it("does not count pairing-store senders for allowlist DM policy", async () => {
    let called = false;
    const state = await resolveDmAllowState({
      provider: "demo-channel-c" as never,
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["owner"],
      readStore: async (_provider, _accountId) => {
        called = true;
        return ["paired-user"];
      },
    });

    expect(called).toBe(false);
    expect(state.allowCount).toBe(1);
    expect(state.isMultiUserDm).toBe(false);
  });

  it.each([
    {
      name: "dmPolicy is allowlist",
      params: {
        provider: "demo-channel-a",
        accountId: "default",
        dmPolicy: "allowlist" as const,
      },
    },
    {
      name: "dmPolicy is open",
      params: {
        provider: "demo-channel-open",
        accountId: "default",
        dmPolicy: "open" as const,
      },
    },
    {
      name: "shouldRead=false",
      params: {
        provider: "demo-channel-b",
        accountId: "default",
        shouldRead: false,
      },
    },
  ] as const)("skips pairing-store reads when $name", async ({ params }) => {
    await expectStoreReadSkipped(params);
  });

  it("builds effective DM/group allowlists from config + pairing store", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner ", "", "owner2"],
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: [" owner3 ", ""],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2", "owner3"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("falls back to DM allowlist for groups when groupAllowFrom is empty", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner "],
      groupAllowFrom: [],
      storeAllowFrom: [" owner2 "],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["owner"]);
  });

  it("can keep group allowlist empty when fallback is disabled", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["owner"],
      groupAllowFrom: [],
      storeAllowFrom: ["paired-user"],
      groupAllowFromFallbackToAllowFrom: false,
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(lists.effectiveGroupAllowFrom).toEqual([]);
  });

  it("infers pinned main DM owner from a single configured allowlist entry", () => {
    const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: "main",
      allowFrom: [" line:user:U123 "],
      normalizeEntry: (entry) =>
        entry
          .trim()
          .toLowerCase()
          .replace(/^line:(?:user:)?/, ""),
    });
    expect(pinnedOwner).toBe("u123");
  });

  it.each([
    {
      name: "wildcard allowlist",
      dmScope: "main" as const,
      allowFrom: ["*"],
    },
    {
      name: "multi-owner allowlist",
      dmScope: "main" as const,
      allowFrom: ["u123", "u456"],
    },
    {
      name: "non-main scope",
      dmScope: "per-channel-peer" as const,
      allowFrom: ["u123"],
    },
  ] as const)("does not infer pinned owner for $name", ({ dmScope, allowFrom }) => {
    expect(
      resolvePinnedMainDmOwnerFromAllowlist({
        dmScope,
        allowFrom: [...allowFrom],
        normalizeEntry: (entry) => entry.trim(),
      }),
    ).toBeNull();
  });

  it("excludes storeAllowFrom when dmPolicy is allowlist", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: ["+2222", "+3333"],
      dmPolicy: "allowlist",
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("excludes pairing-store entries when dmPolicy is open", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["owner"],
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: ["paired-user"],
      dmPolicy: "open",
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("keeps group allowlist explicit when dmPolicy is pairing", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      groupAllowFrom: [],
      storeAllowFrom: ["+2222"],
      dmPolicy: "pairing",
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111", "+2222"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["+1111"]);
  });

  it("resolves access + effective allowlists in one shared call", () => {
    const resolved = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: ["group:room"],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED);
    expect(resolved.reason).toBe("dmPolicy=pairing (allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["group:room"]);
  });

  it("resolves command gate with dm/group parity for groups", () => {
    const resolved = resolveCommandGate({
      isGroup: true,
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reason).toBe("groupPolicy=allowlist (not allowlisted)");
    expect(resolved.commandAuthorized).toBe(false);
    expect(resolved.shouldBlockControlCommand).toBe(true);
  });

  it("keeps configured dm allowlist usable for group command auth", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      isGroup: true,
      dmPolicy: "pairing",
      groupPolicy: "open",
      allowFrom: ["owner"],
      groupAllowFrom: [],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("owner"),
      command: controlCommand,
    });
    expect(resolved.commandAuthorized).toBe(true);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("treats dm command authorization as dm access result", () => {
    const resolved = resolveCommandGate({
      isGroup: false,
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.commandAuthorized).toBe(true);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("does not auto-authorize dm commands in open mode without explicit allowlists", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      isGroup: false,
      dmPolicy: "open",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      storeAllowFrom: [],
      isSenderAllowed: () => false,
      command: controlCommand,
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED);
    expect(resolved.reason).toBe("dmPolicy=open (not allowlisted)");
    expect(resolved.commandAuthorized).toBe(false);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("allows open-mode DMs only for wildcard or matching allowlist entries", () => {
    const publicAccess = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: "open",
      allowFrom: ["*"],
      isSenderAllowed: () => true,
    });
    expect(publicAccess.decision).toBe("allow");
    expect(publicAccess.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN);

    const constrainedAccess = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: "open",
      allowFrom: ["owner"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("owner"),
    });
    expect(constrainedAccess.decision).toBe("allow");
    expect(constrainedAccess.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED);
    expect(constrainedAccess.reason).toBe("dmPolicy=open (allowlisted)");
  });

  it("keeps allowlist mode strict in shared resolver (no pairing-store fallback)", () => {
    const resolved = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: [],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: () => false,
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED);
    expect(resolved.reason).toBe("dmPolicy=allowlist (not allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner"]);
  });

  const channels = [
    "bluebubbles",
    "imessage",
    "signal",
    "telegram",
    "whatsapp",
    "msteams",
    "matrix",
    "zalo",
  ] as const;

  type ParityCase = {
    name: string;
    isGroup: boolean;
    dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
    groupPolicy: "open" | "allowlist" | "disabled";
    allowFrom: string[];
    groupAllowFrom: string[];
    storeAllowFrom: string[];
    isSenderAllowed: (allowFrom: string[]) => boolean;
    expectedDecision: "allow" | "block" | "pairing";
    expectedReactionAllowed: boolean;
  };

  type DecisionCase = {
    name: string;
    input: Parameters<typeof resolveDmGroupAccessDecision>[0];
    expected:
      | ReturnType<typeof resolveDmGroupAccessDecision>
      | Pick<ReturnType<typeof resolveDmGroupAccessDecision>, "decision">;
  };

  function createParityCase({
    name,
    ...overrides
  }: Partial<ParityCase> & Pick<ParityCase, "name">): ParityCase {
    return {
      name,
      isGroup: false,
      dmPolicy: "open",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      storeAllowFrom: [],
      isSenderAllowed: () => false,
      expectedDecision: "allow",
      expectedReactionAllowed: true,
      ...overrides,
    };
  }

  function expectParityCase(channel: (typeof channels)[number], testCase: ParityCase) {
    const access = resolveDmGroupAccessWithLists({
      isGroup: testCase.isGroup,
      dmPolicy: testCase.dmPolicy,
      groupPolicy: testCase.groupPolicy,
      allowFrom: testCase.allowFrom,
      groupAllowFrom: testCase.groupAllowFrom,
      storeAllowFrom: testCase.storeAllowFrom,
      isSenderAllowed: testCase.isSenderAllowed,
    });
    const reactionAllowed = access.decision === "allow";
    expect(access.decision, `[${channel}] ${testCase.name}`).toBe(testCase.expectedDecision);
    expect(reactionAllowed, `[${channel}] ${testCase.name} reaction`).toBe(
      testCase.expectedReactionAllowed,
    );
  }

  it.each(
    channels.flatMap((channel) =>
      [
        createParityCase({
          name: "dmPolicy=open without wildcard",
          dmPolicy: "open",
          expectedDecision: "block",
          expectedReactionAllowed: false,
        }),
        createParityCase({
          name: "dmPolicy=open with wildcard",
          dmPolicy: "open",
          allowFrom: ["*"],
          isSenderAllowed: (allowFrom: string[]) => allowFrom.includes("*"),
          expectedDecision: "allow",
          expectedReactionAllowed: true,
        }),
        createParityCase({
          name: "dmPolicy=disabled",
          dmPolicy: "disabled",
          expectedDecision: "block",
          expectedReactionAllowed: false,
        }),
        createParityCase({
          name: "dmPolicy=allowlist unauthorized",
          dmPolicy: "allowlist",
          allowFrom: ["owner"],
          isSenderAllowed: () => false,
          expectedDecision: "block",
          expectedReactionAllowed: false,
        }),
        createParityCase({
          name: "dmPolicy=allowlist authorized",
          dmPolicy: "allowlist",
          allowFrom: ["owner"],
          isSenderAllowed: () => true,
          expectedDecision: "allow",
          expectedReactionAllowed: true,
        }),
        createParityCase({
          name: "dmPolicy=pairing unauthorized",
          dmPolicy: "pairing",
          isSenderAllowed: () => false,
          expectedDecision: "pairing",
          expectedReactionAllowed: false,
        }),
        createParityCase({
          name: "groupPolicy=allowlist rejects DM-paired sender not in explicit group list",
          isGroup: true,
          dmPolicy: "pairing",
          allowFrom: ["owner"],
          groupAllowFrom: ["group-owner"],
          storeAllowFrom: ["paired-user"],
          isSenderAllowed: (allowFrom: string[]) => allowFrom.includes("paired-user"),
          expectedDecision: "block",
          expectedReactionAllowed: false,
        }),
      ].map((testCase) => ({
        channel,
        testCase,
      })),
    ),
  )(
    "keeps message/reaction policy parity table across channels: [$channel] $testCase.name",
    ({ channel, testCase }) => {
      expectParityCase(channel, testCase);
    },
  );

  const decisionCases: DecisionCase[] = [
    {
      name: "blocks groups when group allowlist is empty",
      input: {
        isGroup: true,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => false,
      },
      expected: {
        decision: "block",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
        reason: "groupPolicy=allowlist (empty allowlist)",
      },
    },
    {
      name: "allows groups when group policy is open",
      input: {
        isGroup: true,
        dmPolicy: "pairing",
        groupPolicy: "open",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => false,
      },
      expected: {
        decision: "allow",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
        reason: "groupPolicy=open",
      },
    },
    {
      name: "blocks DM allowlist mode when allowlist is empty",
      input: {
        isGroup: false,
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => false,
      },
      expected: {
        decision: "block",
        reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
        reason: "dmPolicy=allowlist (not allowlisted)",
      },
    },
    {
      name: "uses pairing flow when DM sender is not allowlisted",
      input: {
        isGroup: false,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => false,
      },
      expected: {
        decision: "pairing",
        reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
        reason: "dmPolicy=pairing (not allowlisted)",
      },
    },
    {
      name: "allows DM sender when allowlisted",
      input: {
        isGroup: false,
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => true,
      },
      expected: {
        decision: "allow",
      },
    },
    {
      name: "blocks group allowlist mode when sender/group is not allowlisted",
      input: {
        isGroup: true,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: ["group:abc"],
        isSenderAllowed: () => false,
      },
      expected: {
        decision: "block",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
        reason: "groupPolicy=allowlist (not allowlisted)",
      },
    },
  ];

  it.each(
    channels.flatMap((channel) =>
      decisionCases.map((testCase) => ({
        channel,
        testCase,
      })),
    ),
  )("[$channel] $testCase.name", ({ testCase }) => {
    const decision = resolveDmGroupAccessDecision(testCase.input);
    if ("reasonCode" in testCase.expected && "reason" in testCase.expected) {
      expect(decision).toEqual(testCase.expected);
      return;
    }
    expect(decision).toMatchObject(testCase.expected);
  });
});
