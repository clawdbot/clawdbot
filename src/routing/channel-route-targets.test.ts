import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectChannelRouteTargets } from "./channel-route-targets.js";

function targetMap(cfg: OpenClawConfig): Map<string, string[]> {
  return new Map(
    collectChannelRouteTargets(cfg).map((target) => [target.agentId, target.channels]),
  );
}

describe("collectChannelRouteTargets", () => {
  it("uses runtime routing to suppress default targets covered by channel routes", () => {
    const targets = targetMap({
      channels: {
        discord: {},
        telegram: {},
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "commander" }],
      },
      bindings: [
        {
          agentId: "commander",
          match: {
            channel: "discord",
          },
        },
      ],
    });

    expect(targets.get("commander")).toEqual(["discord"]);
    expect(targets.get("main")).toEqual(["telegram"]);
  });

  it("samples configured accounts through resolveAgentRoute", () => {
    const targets = targetMap({
      channels: {
        discord: {
          accounts: {
            personal: {},
            work: {},
          },
        },
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "personal-agent" }, { id: "work-agent" }],
      },
      bindings: [
        {
          agentId: "personal-agent",
          match: {
            channel: "Discord",
            accountId: "personal",
          },
        },
        {
          agentId: "work-agent",
          match: {
            channel: "Discord",
            accountId: "work",
          },
        },
      ],
    });

    expect(targets.get("personal-agent")).toEqual(["discord"]);
    expect(targets.get("work-agent")).toEqual(["discord"]);
    expect(targets.has("main")).toBe(false);
  });

  it("does not treat route-binding channel aliases as configured channel coverage", () => {
    const targets = targetMap({
      channels: {
        imessage: {},
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "ios-agent" }],
      },
      bindings: [
        {
          agentId: "ios-agent",
          match: {
            channel: "imsg",
          },
        },
      ],
    });

    expect(targets.get("ios-agent")).toEqual(["imsg"]);
    expect(targets.get("main")).toEqual(["imessage"]);
  });
});
