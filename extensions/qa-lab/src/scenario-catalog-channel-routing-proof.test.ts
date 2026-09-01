import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { formatTransportTranscript, recentOutboundSummary } from "./suite-runtime-transport.js";

type ScenarioRoute = {
  target: string;
  marker: string;
  leakedTarget: string;
};

type ChannelRoutingScenario = {
  scenarioId: string;
  routes: readonly ScenarioRoute[];
  expectedFailure: string;
};

type RouteLeak = "none" | "conversation" | "conversation-kind" | "account";

const routingScenarios = [
  {
    scenarioId: "channel-secondary-conversation-isolation",
    expectedFailure: "secondary conversation leaked into primary route",
    routes: [
      {
        target: "group:primary",
        marker: "QA-PRIMARY-CONVERSATION-OK",
        leakedTarget: "group:secondary",
      },
      {
        target: "group:secondary",
        marker: "QA-SECONDARY-CONVERSATION-OK",
        leakedTarget: "group:primary",
      },
    ],
  },
  {
    scenarioId: "channel-dm-group-routing",
    expectedFailure: "DM/group routes crossed",
    routes: [
      {
        target: "dm:qa-routing-dm",
        marker: "QA-DM-ROUTING-OK",
        leakedTarget: "group:qa-routing-group",
      },
      {
        target: "group:qa-routing-group",
        marker: "QA-GROUP-ROUTING-OK",
        leakedTarget: "dm:qa-routing-dm",
      },
    ],
  },
  {
    scenarioId: "channel-canary",
    expectedFailure: "expected one canary reply, saw 2",
    routes: [
      {
        target: "group:qa-routing-primary",
        marker: "QA-CHANNEL-CANARY-OK",
        leakedTarget: "group:foreign",
      },
    ],
  },
  {
    scenarioId: "dm-chat-baseline",
    expectedFailure: "expected exactly one DM baseline marker reply, saw 2",
    routes: [
      {
        target: "dm:alice",
        marker: "QA-DM-BASELINE-OK",
        leakedTarget: "dm:mallory",
      },
    ],
  },
  {
    scenarioId: "channel-chat-baseline",
    expectedFailure: "expected exactly one channel baseline marker reply, saw 2",
    routes: [
      {
        target: "channel:qa-room",
        marker: "QA-CHANNEL-BASELINE-OK",
        leakedTarget: "dm:mallory",
      },
    ],
  },
] as const satisfies readonly ChannelRoutingScenario[];

function runRoutingScenario(scenario: ChannelRoutingScenario, leak: RouteLeak) {
  return runLoadedScenarioFlow(scenario.scenarioId, {
    state: createQaBusState(),
    api: { formatTransportTranscript, recentOutboundSummary },
    onWaitForOutboundMessage: ({ waitCount, state }) => {
      const route = scenario.routes[waitCount - 1];
      if (!route) {
        throw new Error(`unexpected outbound wait ${waitCount}`);
      }
      state.addOutboundMessage({
        accountId: "qa-channel",
        to: route.target,
        text: route.marker,
      });
      if (leak !== "none") {
        const leakedTarget =
          leak === "conversation"
            ? route.leakedTarget
            : leak === "conversation-kind"
              ? `${route.target.startsWith("dm:") ? "group" : "dm"}:${route.target.split(":")[1]}`
              : route.target;
        state.addOutboundMessage({
          accountId: leak === "account" ? "foreign-account" : "qa-channel",
          to: leakedTarget,
          text: route.marker,
        });
      }
    },
  });
}

describe("channel scenario route isolation", () => {
  it.each(routingScenarios)(
    "accepts replies delivered only to their originating conversation in $scenarioId",
    async (scenario) => {
      await expect(runRoutingScenario(scenario, "none")).resolves.toMatchObject({ status: "pass" });
    },
  );

  it.each(routingScenarios)(
    "rejects and identifies replies leaked into another conversation in $scenarioId",
    async (scenario) => {
      const result = runRoutingScenario(scenario, "conversation");

      await expect(result).rejects.toThrow(scenario.expectedFailure);
      for (const route of scenario.routes) {
        await expect(result).rejects.toThrow(route.leakedTarget.split(":")[1]);
      }
    },
  );

  it.each(
    routingScenarios
      .slice(0, 2)
      .flatMap((scenario) =>
        (["conversation-kind", "account"] as const).map((leak) => ({ scenario, leak })),
      ),
  )(
    "rejects a same-ID $leak route collision in $scenario.scenarioId",
    async ({ scenario, leak }) => {
      const result = runRoutingScenario(scenario, leak);
      const firstRoute = scenario.routes[0];
      const conversationId = firstRoute.target.split(":")[1];
      const expectedKind = firstRoute.target.startsWith("dm:") ? "direct" : "group";
      const leakedKind =
        leak === "conversation-kind"
          ? expectedKind === "direct"
            ? "group"
            : "direct"
          : expectedKind;
      const leakedAccount = leak === "account" ? "foreign-account" : "qa-channel";

      await expect(result).rejects.toThrow(scenario.expectedFailure);
      await expect(result).rejects.toThrow(`qa-channel:${expectedKind}:${conversationId}:`);
      await expect(result).rejects.toThrow(`${leakedAccount}:${leakedKind}:${conversationId}:`);
    },
  );

  it("reports the blocked actor reply instead of crashing while formatting its transcript", async () => {
    const result = runLoadedScenarioFlow("channel-multi-actor-ordering", {
      state: createQaBusState(),
      api: { formatTransportTranscript, recentOutboundSummary },
      onWaitForOutboundMessage: ({ state }) => {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "group:qa-routing-ordering",
          text: "QA-MULTI-ACTOR-ORDERING-OK",
        });
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "group:qa-routing-ordering",
          text: "QA-BLOCKED-ACTOR-SHOULD-NOT-REPLY",
        });
      },
    });

    await expect(result).rejects.toThrow("blocked actor produced a reply");
    await expect(result).rejects.toThrow("QA-BLOCKED-ACTOR-SHOULD-NOT-REPLY");
  });
});
