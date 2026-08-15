import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";
import { collectRuntimeCommandTree } from "./runtime-commands.js";

describe("runtime command catalog", () => {
  it("enumerates the currently registered Commander tree", () => {
    const program = new Command();
    program.command("alpha").description("Alpha command").alias("a");
    program
      .command("beta")
      .description("Beta command")
      .command("child")
      .description("Nested child");
    program
      .command("secret", { hidden: true })
      .description("Hidden command")
      .command("child")
      .description("Hidden child");

    const runtimeCommands = collectRuntimeCommandTree(program);

    expect(runtimeCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandPath: ["alpha"],
          parentPath: [],
          depth: 1,
          aliases: ["a"],
          visibleSubcommandCount: 0,
          hidden: false,
          discoveryMode: "runtime-registered",
          sourceKind: "runtime",
        }),
        expect.objectContaining({
          commandPath: ["beta"],
          hasSubcommands: true,
          visibleSubcommandCount: 1,
        }),
        expect.objectContaining({ commandPath: ["beta", "child"], parentPath: ["beta"], depth: 2 }),
      ]),
    );
    expect(runtimeCommands.map((command) => command.commandPath)).not.toContainEqual(["secret"]);
    expect(runtimeCommands.map((command) => command.commandPath)).not.toContainEqual([
      "secret",
      "child",
    ]);
    expect(
      runtimeCommands.find((command) => command.commandPath[0] === "secret-visible-parent"),
    ).toBeUndefined();
    expect(buildCatalogList({ runtimeCommands }).counts.runtimeCommands).toBe(3);
  });

  it("keeps runtime descriptions inside their Markdown table cells", () => {
    const program = new Command();
    program.command("alpha").description("Alpha | command\nfor operators");
    const runtimeCommands = collectRuntimeCommandTree(program);

    expect(renderCatalogListMarkdown({ runtimeCommands })).toContain(
      "| `alpha` | None | 1 | 0 | Alpha \\| command for operators |",
    );
  });
});
