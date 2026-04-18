import { describe, expect, it } from "vitest";
import {
  getSignalContractSurface,
  type SignalSender,
} from "../../../../test/helpers/channels/dm-policy-contract.js";
import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists,
} from "../../../security/dm-policy-shared.js";

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

function createChannelSmokeCases(
  isSignalSenderAllowed: (sender: SignalSender, allowFrom: string[]) => boolean,
): ChannelSmokeCase[] {
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

describe("security/dm-policy-shared channel smoke", () => {
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

  it("blocks group ingress when sender is only in pairing store", async () => {
    const { isSignalSenderAllowed } = await getSignalContractSurface();
    for (const { testCase } of expandChannelIngressCases(
      createChannelSmokeCases(isSignalSenderAllowed),
    )) {
      expectBlockedGroupAccess({
        storeAllowFrom: testCase.storeAllowFrom,
        isSenderAllowed: testCase.isSenderAllowed,
      });
    }
  });
});
