import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";
import { describe, expect, it } from "vitest";
import { isSignalSenderAllowed, type SignalSender } from "../contract-api.js";

type ChannelSmokeCase = {
  name: string;
  storeAllowFrom: string[];
  isSenderAllowed: (allowFrom: string[]) => boolean;
};

const signalSender: SignalSender = {
  kind: "phone",
  raw: "+15550001111",
  e164: "+15550001111",
};
const signalSenderE164 = "+15550001111";

function createChannelSmokeCases(): ChannelSmokeCase[] {
  return [
    {
      name: "bluebubbles",
      storeAllowFrom: ["attacker-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("attacker-user"),
    },
    {
      name: "signal",
      storeAllowFrom: [signalSenderE164],
      isSenderAllowed: (allowFrom) => isSignalSenderAllowed(signalSender, allowFrom),
    },
    {
      name: "mattermost",
      storeAllowFrom: ["user:attacker-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("user:attacker-user"),
    },
  ];
}

function expandChannelIngressCases(cases: readonly ChannelSmokeCase[]) {
  return cases.flatMap((testCase) =>
    (["message", "reaction"] as const).map((ingress) => ({
      testCase,
      ingress,
    })),
  );
}

describe("Signal dm-policy shared contract", () => {
  function expectBlockedGroupAccess(params: {
    storeAllowFrom: string[];
    isSenderAllowed: (allowFrom: string[]) => boolean;
  }) {
    const access = resolveDmGroupAccessWithLists({
      isGroup: true,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner-user"],
      groupAllowFrom: ["group-owner"],
      storeAllowFrom: params.storeAllowFrom,
      isSenderAllowed: params.isSenderAllowed,
    });
    expect(access.decision).toBe("block");
    expect(access.reasonCode).toBe(DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED);
    expect(access.reason).toBe("groupPolicy=allowlist (not allowlisted)");
  }

  it("blocks group ingress when sender is only in pairing store", () => {
    for (const { testCase } of expandChannelIngressCases(createChannelSmokeCases())) {
      expectBlockedGroupAccess({
        storeAllowFrom: testCase.storeAllowFrom,
        isSenderAllowed: testCase.isSenderAllowed,
      });
    }
  });
});
