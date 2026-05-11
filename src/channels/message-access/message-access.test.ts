import { describe, expect, it } from "vitest";
import {
  decideChannelIngress,
  resolveChannelIngressState,
  type ChannelIngressPolicyInput,
  type ChannelIngressStateInput,
  type InternalChannelIngressAdapter,
  type InternalChannelIngressSubject,
} from "./index.js";

const subject = (value: string): InternalChannelIngressSubject => ({
  identifiers: [{ opaqueId: "subject-1", kind: "stable-id", value }],
});

const adapter: InternalChannelIngressAdapter = {
  normalizeEntries({ entries }) {
    return {
      matchable: entries.map((entry, index) => ({
        opaqueEntryId: `entry-${index + 1}`,
        kind: "stable-id",
        value: entry,
        dangerous: entry.startsWith("display:"),
      })),
      invalid: [],
      disabled: [],
    };
  },
  matchSubject({ subject, entries }) {
    const values = new Set(subject.identifiers.map((identifier) => identifier.value));
    const matchedEntryIds = entries
      .filter((entry) => entry.value === "*" || values.has(entry.value))
      .map((entry) => entry.opaqueEntryId);
    return { matched: matchedEntryIds.length > 0, matchedEntryIds };
  },
};

const lowerCaseAdapter: InternalChannelIngressAdapter = {
  normalizeEntries({ entries }) {
    return {
      matchable: entries.map((entry, index) => ({
        opaqueEntryId: `entry-${index + 1}`,
        kind: "stable-id",
        value: entry.toLowerCase(),
      })),
      invalid: [],
      disabled: [],
    };
  },
  matchSubject({ subject, entries }) {
    const values = new Set(subject.identifiers.map((identifier) => identifier.value.toLowerCase()));
    const matchedEntryIds = entries
      .filter((entry) => entry.kind === "stable-id" && values.has(entry.value))
      .map((entry) => entry.opaqueEntryId);
    return { matched: matchedEntryIds.length > 0, matchedEntryIds };
  },
};

function baseInput(overrides: Partial<ChannelIngressStateInput> = {}): ChannelIngressStateInput {
  return {
    channelId: "test",
    accountId: "default",
    subject: subject("sender-1"),
    conversation: { kind: "direct", id: "dm-1" },
    adapter,
    event: { kind: "message", authMode: "inbound", mayPair: true },
    allowlists: {},
    ...overrides,
  };
}

const policy: ChannelIngressPolicyInput = {
  dmPolicy: "pairing",
  groupPolicy: "allowlist",
};

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toBeDefined();
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

describe("channel message access ingress", () => {
  it.each([
    {
      name: "keeps pairing-store entries DM-policy scoped",
      input: baseInput({
        subject: subject("paired-sender"),
        allowlists: { pairingStore: ["paired-sender"] },
      }),
      policy: { ...policy, dmPolicy: "open" as const },
      expected: { admission: "drop", reasonCode: "dm_policy_not_allowlisted" },
      secondPolicy: { ...policy, dmPolicy: "pairing" as const },
      secondExpected: { admission: "dispatch", decision: "allow" },
    },
    {
      name: "requires explicit group fallback to DM allowlists",
      input: baseInput({
        conversation: { kind: "group", id: "room-1" },
        allowlists: { dm: ["sender-1"] },
      }),
      policy,
      expected: { admission: "drop", reasonCode: "group_policy_empty_allowlist" },
      secondPolicy: { ...policy, groupAllowFromFallbackToAllowFrom: true },
      secondExpected: { admission: "dispatch", decision: "allow" },
    },
    {
      name: "requires explicit dangerous identifier matching",
      input: baseInput({
        subject: subject("display:sender-1"),
        allowlists: { dm: ["display:sender-1"] },
      }),
      policy: { ...policy, dmPolicy: "allowlist" as const },
      expected: { admission: "drop", reasonCode: "dm_policy_not_allowlisted" },
      secondPolicy: {
        ...policy,
        dmPolicy: "allowlist" as const,
        mutableIdentifierMatching: "enabled" as const,
      },
      secondExpected: { admission: "dispatch", decision: "allow" },
    },
  ])("$name", async ({ input, policy, expected, secondPolicy, secondExpected }) => {
    const state = await resolveChannelIngressState(input);
    expectRecordFields(decideChannelIngress(state, policy), expected);
    expectRecordFields(decideChannelIngress(state, secondPolicy), secondExpected);
  });

  it("applies route sender allowlists without retaining raw sender values", async () => {
    const rawSender = "route-sender@example.test";
    const state = await resolveChannelIngressState(
      baseInput({
        subject: subject(rawSender),
        conversation: { kind: "group", id: "room-1" },
        routeFacts: [
          {
            id: "space-1",
            kind: "route",
            gate: "matched",
            effect: "allow",
            precedence: 0,
            senderPolicy: "replace",
            senderAllowFrom: [rawSender],
          },
        ],
        allowlists: { group: ["group-sender"] },
      }),
    );

    const decision = decideChannelIngress(state, policy);

    const senderAllowlist = expectRecordFields(state.routeFacts[0]?.senderAllowlist, {
      hasConfiguredEntries: true,
    });
    expectRecordFields(senderAllowlist.match, { matched: true });
    expectRecordFields(decision, { admission: "dispatch", decision: "allow" });
    expect(JSON.stringify(state)).not.toContain(rawSender);
    expect(JSON.stringify(decision)).not.toContain(rawSender);
  });

  it("blocks matched routes with deny-when-empty sender policy", async () => {
    const state = await resolveChannelIngressState(
      baseInput({
        routeFacts: [
          {
            id: "space-1",
            kind: "route",
            gate: "matched",
            effect: "allow",
            precedence: 0,
            senderPolicy: "deny-when-empty",
            senderAllowFrom: [],
          },
        ],
        allowlists: { dm: ["sender-1"] },
      }),
    );

    expectRecordFields(decideChannelIngress(state, policy), {
      admission: "drop",
      reasonCode: "route_sender_empty",
    });
    expect(state.routeFacts[0]).not.toHaveProperty("senderAllowFrom");
  });

  it.each([
    {
      name: "allows origin-subject events for the same normalized actor",
      adapter,
      current: "sender-1",
      origin: "sender-1",
      matched: true,
      expected: { admission: "dispatch", decision: "allow" },
    },
    {
      name: "does not authorize by default opaque identifier slots",
      adapter,
      current: "sender-1",
      origin: "different-sender",
      matched: false,
      expected: { admission: "drop", decision: "block", reasonCode: "origin_subject_not_matched" },
    },
    {
      name: "uses adapter-normalized identity values",
      adapter: lowerCaseAdapter,
      current: "Sender-1",
      origin: "sender-1",
      matched: true,
      expected: { admission: "dispatch", decision: "allow" },
    },
  ])("$name", async (entry) => {
    const state = await resolveChannelIngressState(
      baseInput({
        adapter: entry.adapter,
        subject: subject(entry.current),
        event: {
          kind: "reaction",
          authMode: "origin-subject",
          mayPair: false,
          originSubject: subject(entry.origin),
        },
      }),
    );
    const decision = decideChannelIngress(state, policy);

    expect(state.event.originSubjectMatched).toBe(entry.matched);
    expectRecordFields(decision, entry.expected);
    if (entry.matched) {
      const gate = decision.graph.gates.find(
        (gate) => gate.phase === "sender" && gate.kind === "dmSender",
      );
      expectRecordFields(gate, {
        effect: "ignore",
        reasonCode: "sender_not_required",
      });
    }
  });
});
