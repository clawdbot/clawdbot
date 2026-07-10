import { describe, expect, it } from "vitest";
import type { CliCatalogNodeCommand } from "../cli-catalog-overlay/node-commands.js";
import { buildCommandInventoryPromptSection } from "./command-inventory-prompt.js";

const nodeCommand: CliCatalogNodeCommand = {
  id: "node:desk:filesystem.read",
  command: "filesystem.read",
  title: "filesystem.read",
  nodeId: "desk",
  description: "Live command advertised by paired node Desk.",
  argumentHints: ["path"],
  invocationHint: "openclaw nodes invoke --node desk --command filesystem.read",
  availability: "available",
  approvalKind: "gateway-allowlist",
  risk: "high",
  confirmationRequired: true,
  effectMode: "mixed",
  effects: [],
  trustBoundary: "paired-node",
  sourceKind: "node-runtime",
  sourceId: "desk:filesystem.read",
  discoveryMode: "runtime-node-query",
  visibility: ["prompt", "audit", "operator"],
};

describe("buildCommandInventoryPromptSection", () => {
  it("renders a lean command-only routing section", () => {
    const section = buildCommandInventoryPromptSection({
      availableTools: new Set(["exec"]),
    }).join("\n");

    expect(section).toContain("## OpenClaw Commands");
    expect(section).toContain("gateway-status->openclaw gateway status");
    expect(section).toContain(
      "Do not run commands marked confirmation=user until the user explicitly confirms",
    );
    expect(section).toContain("config-unset->openclaw config unset risk=medium confirmation=user");
    expect(section).not.toContain("skill_workshop");
    expect(section).not.toContain("session_status");
    expect(section.length).toBeLessThan(1800);
    expect(Math.round(section.length / 4)).toBeLessThan(450);
  });

  it("omits host commands when exec is unavailable", () => {
    expect(buildCommandInventoryPromptSection({ availableTools: new Set(["read"]) })).toEqual([]);
  });

  it("omits host commands in sandboxed runtimes", () => {
    expect(
      buildCommandInventoryPromptSection({
        availableTools: new Set(["exec"]),
        hostCliAvailable: false,
      }),
    ).toEqual([]);
  });

  it("renders selected node commands in node-operator scope without host exec", () => {
    const section = buildCommandInventoryPromptSection({
      availableTools: new Set(["nodes"]),
      hostCliAvailable: false,
      scope: "node-operator",
      nodeCommands: [nodeCommand],
    }).join("\n");

    expect(section).toContain("node:desk:filesystem.read->filesystem.read");
    expect(section).toContain("via=nodes action=invoke node=desk invokeCommand=filesystem.read");
    expect(section).toContain("risk=high confirmation=user");
    expect(section).not.toContain("gateway-status->openclaw gateway status");
  });

  it("caps the fully rendered prompt section after formatting maximum-size node rows", () => {
    const nodeCommands = Array.from({ length: 32 }, (_, index) => ({
      ...nodeCommand,
      id: `node:${"n".repeat(120 - String(index).length)}${index}:command-${index}`,
      nodeId: `${"n".repeat(120 - String(index).length)}${index}`,
      command: `command-${index}`,
      argumentHints: ["path", "safe_name", "workspaceRoot", "outputFormat"],
    }));

    const section = buildCommandInventoryPromptSection({
      availableTools: new Set(["nodes"]),
      hostCliAvailable: false,
      scope: "node-operator",
      nodeCommands,
    }).join("\n");

    expect(section.length).toBeLessThanOrEqual(1800);
    expect(section).toContain("## OpenClaw Commands");
    expect(section).toContain("node:");
  });

  it("omits node commands when the nodes tool is unavailable", () => {
    expect(
      buildCommandInventoryPromptSection({
        availableTools: new Set(["read"]),
        scope: "node-operator",
        nodeCommands: [nodeCommand],
      }),
    ).toEqual([]);
  });

  it("caps the aggregate command guidance section", () => {
    const section = buildCommandInventoryPromptSection({
      availableTools: new Set(["exec", "nodes"]),
      nodeCommands: Array.from({ length: 80 }, (_, index) => ({
        ...nodeCommand,
        id: `node:desk:camera.snap.${index}`,
        command: `camera.snap.${index}`,
        title: `camera.snap.${index}`,
        sourceId: `desk:camera.snap.${index}`,
      })),
      scope: "node-operator",
    }).join("\n");

    expect(section).toContain("## OpenClaw Commands");
    expect(section.length).toBeLessThanOrEqual(1800);
  });
});
