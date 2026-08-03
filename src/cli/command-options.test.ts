// Command option tests cover shared CLI option registration and parsing.
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { hasExplicitOptions, inheritOptionFromParent } from "./command-options.js";

function attachRunCommandAndCaptureInheritedToken(command: Command) {
  let inherited: string | undefined;
  command
    .command("run")
    .option("--token <token>", "Run token")
    .action((_opts, childCommand) => {
      inherited = inheritOptionFromParent<string>(childCommand, "token");
    });
  return () => inherited;
}

describe("hasExplicitOptions", () => {
  it.each([
    { source: "cli", expected: true },
    { source: "config", expected: false },
    { source: "env", expected: false },
    { source: "implied", expected: false },
    { source: "default", expected: false },
    { source: undefined, expected: false },
  ] as const)("recognizes only cli option sources ($source)", ({ source, expected }) => {
    const command = new Command().option("--token <token>", "Token");
    command.setOptionValueWithSource("token", "test-token", source);

    expect(hasExplicitOptions(command, ["token"])).toBe(expected);
  });

  it("recognizes an explicitly negated option", async () => {
    const command = new Command().option("--no-color", "Disable color");

    await command.parseAsync(["--no-color"], { from: "user" });

    expect(command.getOptionValue("color")).toBe(false);
    expect(hasExplicitOptions(command, ["color"])).toBe(true);
  });

  it("checks every requested option", async () => {
    const command = new Command()
      .option("--token <token>", "Token")
      .option("--force", "Force", false);

    await command.parseAsync(["--force"], { from: "user" });

    expect(hasExplicitOptions(command, ["token", "force"])).toBe(true);
    expect(hasExplicitOptions(command, ["token"])).toBe(false);
    expect(hasExplicitOptions(command, [])).toBe(false);
  });
});

describe("inheritOptionFromParent", () => {
  it.each([
    {
      label: "inherits from grandparent when parent does not define the option",
      parentHasTokenOption: false,
      argv: ["--token", "root-token", "gateway", "run"],
      expected: "root-token",
    },
    {
      label: "prefers nearest ancestor value when multiple ancestors set the same option",
      parentHasTokenOption: true,
      argv: ["--token", "root-token", "gateway", "--token", "gateway-token", "run"],
      expected: "gateway-token",
    },
  ])("$label", async ({ parentHasTokenOption, argv, expected }) => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = parentHasTokenOption
      ? program.command("gateway").option("--token <token>", "Gateway token")
      : program.command("gateway");
    const getInherited = attachRunCommandAndCaptureInheritedToken(gateway);

    await program.parseAsync(argv, { from: "user" });
    expect(getInherited()).toBe(expected);
  });

  it("does not inherit when the child option was set explicitly", () => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = program.command("gateway").option("--token <token>", "Gateway token");
    const run = gateway.command("run").option("--token <token>", "Run token");

    program.setOptionValueWithSource("token", "root-token", "cli");
    gateway.setOptionValueWithSource("token", "gateway-token", "cli");
    run.setOptionValueWithSource("token", "run-token", "cli");

    expect(inheritOptionFromParent<string>(run, "token")).toBeUndefined();
  });

  it("inherits explicitly negated ancestor values", async () => {
    const program = new Command();
    const gateway = program.command("gateway").option("--no-color", "Disable color");
    const run = gateway
      .command("run")
      .option("--no-color", "Disable color")
      .action(() => {});

    await program.parseAsync(["gateway", "--no-color", "run"], { from: "user" });

    expect(inheritOptionFromParent<boolean>(run, "color")).toBe(false);
  });

  it("does not override an explicitly negated child value", async () => {
    const program = new Command();
    const gateway = program.command("gateway").option("--force", "Force");
    const run = gateway
      .command("run")
      .option("--no-force", "Disable force")
      .action(() => {});

    await program.parseAsync(["gateway", "--force", "run", "--no-force"], {
      from: "user",
    });

    expect(run.getOptionValue("force")).toBe(false);
    expect(inheritOptionFromParent<boolean>(run, "force")).toBeUndefined();
  });

  it("does not inherit from ancestors beyond the bounded traversal depth", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const level1 = program.command("level1");
    const level2 = level1.command("level2");
    const getInherited = attachRunCommandAndCaptureInheritedToken(level2);

    await program.parseAsync(["--token", "root-token", "level1", "level2", "run"], {
      from: "user",
    });
    expect(getInherited()).toBeUndefined();
  });

  it("inherits values from non-default ancestor sources (for example env)", () => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = program.command("gateway").option("--token <token>", "Gateway token");
    const run = gateway.command("run").option("--token <token>", "Run token");

    gateway.setOptionValueWithSource("token", "gateway-env-token", "env");

    expect(inheritOptionFromParent<string>(run, "token")).toBe("gateway-env-token");
  });

  it("skips default-valued ancestor options and keeps traversing", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = program
      .command("gateway")
      .option("--token <token>", "Gateway token", "default");
    const getInherited = attachRunCommandAndCaptureInheritedToken(gateway);

    await program.parseAsync(["--token", "root-token", "gateway", "run"], {
      from: "user",
    });
    expect(getInherited()).toBe("root-token");
  });

  it("returns undefined when command is missing", () => {
    expect(inheritOptionFromParent<string>(undefined, "token")).toBeUndefined();
  });
});
