import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { inheritOptionFromParent } from "./command-options.js";

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
