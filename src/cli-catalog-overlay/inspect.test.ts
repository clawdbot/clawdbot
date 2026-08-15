import { describe, expect, it } from "vitest";
import { inspectCommand, renderCommandInspectionMarkdown } from "./inspect.js";
import { buildCatalogList } from "./list.js";

describe("command inventory inspect", () => {
  it("joins records for an exact command path", () => {
    const inspection = inspectCommand(buildCatalogList(), ["gateway", "status"]);

    expect(inspection.found).toBe(true);
    expect(inspection.routes.map((route) => route.commandPath)).toEqual([
      ["gateway"],
      ["gateway", "status"],
    ]);
    expect(inspection.routedOperations.map((operation) => operation.id)).toContain(
      "gateway-status",
    );
  });

  it("inspects supplied node commands", () => {
    const list = buildCatalogList({
      nodeCommands: [
        {
          id: "node:demo:filesystem.read",
          command: "filesystem.read",
          title: "Read a file",
          description: "Read a file from the paired node",
          argumentHints: ["path"],
          invocationHint: "filesystem.read path=<path>",
          availability: "approved",
          approvalKind: "pairing",
          risk: "low",
          confirmationRequired: false,
          effectMode: "read",
          effects: ["filesystem.read"],
          trustBoundary: "paired-node",
          sourceKind: "node-pairing",
          sourceId: "demo:filesystem.read",
          discoveryMode: "paired-node-declaration",
          visibility: ["audit", "operator"],
        },
      ],
    });

    expect(inspectCommand(list, ["filesystem.read"]).nodeCommands).toHaveLength(1);
  });

  it("reports unknown command paths without fuzzy matching", () => {
    const inspection = inspectCommand(buildCatalogList(), ["missing"]);

    expect(inspection.found).toBe(false);
    expect(renderCommandInspectionMarkdown(inspection)).toContain("No matching command was found.");
  });

  it("does not treat an inherited route policy as command existence", () => {
    const inspection = inspectCommand(buildCatalogList(), ["gateway", "missing"]);

    expect(inspection.found).toBe(false);
    expect(inspection.routes.map((route) => route.commandPath)).toEqual([["gateway"]]);
  });

  it("includes inherited operations without treating them as command existence", () => {
    const inspection = inspectCommand(buildCatalogList(), ["tasks", "missing"]);

    expect(inspection.found).toBe(false);
    expect(inspection.routedOperations.map((operation) => operation.id)).toContain("tasks-list");
  });

  it("resolves runtime aliases before joining command records", () => {
    const list = buildCatalogList({
      runtimeCommands: [
        {
          commandPath: ["infer"],
          parentPath: [],
          depth: 1,
          name: "infer",
          aliases: ["capability"],
          description: "Run inference",
          hasSubcommands: false,
          visibleSubcommandCount: 0,
          hidden: false,
          sourceKind: "runtime",
          sourceId: "infer",
          discoveryMode: "runtime-registered",
          visibility: ["operator"],
        },
      ],
    });

    const inspection = inspectCommand(list, ["capability"]);
    expect(inspection.found).toBe(true);
    expect(inspection.resolvedCommandPath).toEqual(["infer"]);
    expect(inspection.runtimeCommands).toHaveLength(1);
  });

  it("uses a Markdown fence longer than plugin-controlled content", () => {
    const list = buildCatalogList({
      pluginCommands: [
        {
          pluginId: "example",
          commandPath: ["example"],
          parentPath: [],
          depth: 1,
          name: "example",
          descriptorName: "example",
          description: "contains ``` fence",
          hasSubcommands: false,
          commandHints: ["example"],
          sourceKind: "plugin",
          sourceId: "example:example",
          discoveryMode: "plugin-descriptor",
        },
      ],
    });

    expect(renderCommandInspectionMarkdown(inspectCommand(list, ["example"]))).toContain(
      "````json",
    );
  });
});
