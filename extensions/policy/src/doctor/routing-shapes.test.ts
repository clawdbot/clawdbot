import { describe, expect, it } from "vitest";
import { routingPolicyShapeFinding } from "./routing-shapes.js";

const ctx = { policyPath: "policy.jsonc", policyDocName: "policy.jsonc" };

describe("routing policy shape", () => {
  it("accepts a complete authored probe", () => {
    expect(
      routingPolicyShapeFinding(
        {
          requireBindings: true,
          requireConfiguredChannels: true,
          probes: [
            {
              id: "family-dm",
              route: {
                channel: "imessage",
                accountId: "default",
                peer: { kind: "direct", id: "+15555550123" },
              },
              expect: { agentId: "family", matchedBy: ["binding.peer"] },
            },
          ],
        },
        ctx,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      {
        probes: [
          { id: "same", route: { channel: "imessage" }, expect: { agentId: "a" } },
          { id: "same", route: { channel: "imessage" }, expect: { agentId: "b" } },
        ],
      },
      "must be unique",
    ],
    [
      {
        probes: [
          {
            id: "x",
            route: { channel: "imessage", peer: { kind: "dm", id: "secret" } },
            expect: { agentId: "a" },
          },
        ],
      },
      "must be direct, group, or channel",
    ],
    [
      {
        probes: [
          {
            id: "x",
            route: { channel: "imessage" },
            expect: { agentId: "a", matchedBy: ["unknown"] },
          },
        ],
      },
      "supported match kinds",
    ],
    [{ requireBindings: "yes" }, "must be a boolean"],
  ])("rejects malformed routing syntax", (value, message) => {
    expect(routingPolicyShapeFinding(value, ctx)?.message).toContain(message);
  });
});
