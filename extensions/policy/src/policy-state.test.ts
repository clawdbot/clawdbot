import { describe, expect, it } from "vitest";
import { scanPolicyChannels, scanPolicyTools } from "./policy-state.js";

describe("scanPolicyChannels", () => {
  it("ignores reserved channel config namespaces", () => {
    expect(
      scanPolicyChannels({
        channels: {
          defaults: {
            provider: "telegram",
          },
          modelByChannel: {
            telegram: "openai/gpt-5.5",
          },
          telegram: {
            enabled: true,
          },
        },
      }),
    ).toEqual([
      {
        enabled: true,
        id: "telegram",
        provider: "telegram",
        source: "oc://openclaw.config/channels/telegram",
      },
    ]);
  });

  it("does not treat channel arrays as channel config maps", () => {
    expect(
      scanPolicyChannels({
        channels: [{ enabled: true }],
      }),
    ).toEqual([]);
  });
});

describe("scanPolicyTools", () => {
  it("scans documented bullet tool declarations", async () => {
    await expect(
      scanPolicyTools(
        [
          "## Tools",
          "- deploy_tool: risk: critical sensitivity: restricted owner: ops IRREVERSIBLE_EXTERNAL",
          "- inspect: risk: low",
          "  sensitivity: public",
          "  owner: support",
        ].join("\n"),
      ),
    ).resolves.toEqual([
      {
        id: "deploy-tool",
        source: "oc://TOOLS.md/tools/deploy-tool",
        line: 2,
        risk: "critical",
        sensitivity: "restricted",
        owner: "ops",
        capabilities: ["IRREVERSIBLE_EXTERNAL"],
      },
      {
        id: "inspect",
        source: "oc://TOOLS.md/tools/inspect",
        line: 3,
        risk: "low",
        sensitivity: "public",
        owner: "support",
      },
    ]);
  });

  it("does not treat indented metadata bullets as tool declarations", async () => {
    await expect(
      scanPolicyTools(["## Tools", "- deploy: risk: critical", "  - owner: ops"].join("\n")),
    ).resolves.toEqual([
      {
        id: "deploy",
        source: "oc://TOOLS.md/tools/deploy",
        line: 2,
        risk: "critical",
        owner: "ops",
      },
    ]);
  });
});
