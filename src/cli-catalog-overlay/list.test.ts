import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";

const sampleNodeCommands: readonly CliCatalogNodeCommand[] = [
  {
    id: "node:demo-filesystem:filesystem.read",
    command: "filesystem.read",
    title: "Read file through paired node",
    nodeId: "demo-filesystem",
    nodeName: "Demo filesystem node",
    cap: "filesystem",
    description: "Read a file through a paired node command declaration.",
    argumentHints: ["path"],
    invocationHint:
      'openclaw nodes invoke --node demo-filesystem --command filesystem.read --params {"path":"..."}',
    availability: "approved",
    approvalKind: "pairing",
    risk: "medium",
    confirmationRequired: true,
    effectMode: "read",
    effects: ["filesystem.read"],
    trustBoundary: "paired-node",
    sourceKind: "node-pairing",
    sourceId: "demo-filesystem:filesystem.read",
    discoveryMode: "paired-node-declaration",
    visibility: ["docs", "audit", "operator", "policy"],
  },
];

describe("command inventory list", () => {
  it("builds a read-only programmatic list", () => {
    const list = buildCatalogList();

    expect(list).toMatchObject({
      schemaVersion: 1,
      generatedFrom: "command-inventory",
      counts: {
        runtimeCommands: 0,
        nodeCommands: 0,
      },
    });
    expect(list.cli.runtimeCommandScope).toBe("current-invocation-registered-tree");
    expect(list.cli.nodeCommandScope).toBe("caller-supplied");
    expect(list.collection).toEqual({
      descriptors: "complete",
      commandRoutes: "complete",
      runtimeCommands: "not-requested",
      pluginCommands: "not-requested",
      nodeCommands: "not-requested",
    });
    expect(list.cli.descriptors.map((descriptor) => descriptor.name)).not.toContain("crestodian");
    expect(list.cli.descriptors.find((descriptor) => descriptor.name === "gateway")).toMatchObject({
      source: "subcli",
      hasSubcommands: true,
    });
    expect(
      list.cli.routedOperations.find((operation) => operation.id === "gateway-status"),
    ).toMatchObject({ commandPaths: [["gateway", "status"]] });
    expect(
      list.cli.routedOperations.find((operation) => operation.id === "config-unset"),
    ).toMatchObject({
      risk: "medium",
      confirmationRequired: true,
      effectMode: "mutating",
    });
    expect(list.counts.commandDescriptors).toBeGreaterThan(50);
    expect(list.counts.commandRoutes).toBeGreaterThan(90);
    expect(list.counts.routedOperations).toBeGreaterThan(10);
  });

  it("preserves unknown routed-operation effects", () => {
    const operation = buildCatalogList().cli.routedOperations.find(
      (entry) => entry.id === "agents-list",
    );

    expect(operation).toBeDefined();
    expect(operation).not.toHaveProperty("risk");
    expect(operation).not.toHaveProperty("confirmationRequired");
    expect(operation).not.toHaveProperty("effectMode");
  });

  it("carries supplied node/operator commands through the list contract", () => {
    const list = buildCatalogList({ nodeCommands: sampleNodeCommands });

    expect(list.counts.nodeCommands).toBe(1);
    expect(list.cli.nodeCommands[0]).toMatchObject({
      id: "node:demo-filesystem:filesystem.read",
      command: "filesystem.read",
      availability: "approved",
      approvalKind: "pairing",
      trustBoundary: "paired-node",
    });
  });

  it("renders a Markdown command inventory", () => {
    const markdown = renderCatalogListMarkdown();

    expect(markdown).toContain("# OpenClaw Commands");
    expect(markdown).toContain("- CLI descriptors:");
    expect(markdown).toContain("- Command routes:");
    expect(markdown).toContain("- Runtime command scope: current-invocation-registered-tree");
    expect(markdown).toContain("- Supplied node commands: 0");
    expect(markdown).toContain("- Node command scope: caller-supplied");
    expect(markdown).toContain(
      "| `gateway-status` | `unknown` | `unknown` | unknown | `gateway status` |",
    );
    expect(markdown).not.toContain("Agent/tool surfaces");
  });

  it("renders node/operator command rows when supplied", () => {
    const markdown = renderCatalogListMarkdown({ nodeCommands: sampleNodeCommands });

    expect(markdown).toContain("## Node/operator commands");
    expect(markdown).toContain(
      "| `filesystem.read` | Demo filesystem node | `approved` | `pairing` |",
    );
  });

  it("keeps supplied node metadata inside its Markdown table cells", () => {
    const command = {
      ...sampleNodeCommands[0]!,
      command: "filesystem.`read`|raw",
      nodeName: "Build | prod\nprimary",
      invocationHint: "nodes invoke `filesystem.read` | inspect\nnext",
    };

    const markdown = renderCatalogListMarkdown({ nodeCommands: [command] });

    expect(markdown).toContain(
      "| `` filesystem.`read`\\|raw `` | Build \\| prod primary | `approved` | `pairing` |",
    );
    expect(markdown).toContain("`` nodes invoke `filesystem.read` \\| inspect next ``");
    expect(markdown).not.toContain("Build | prod\nprimary");
  });
});
