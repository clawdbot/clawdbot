import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addGatewayRunCommand } from "./run-command.js";

const runGatewayCommandMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./run.js", () => ({
  runGatewayCommand: runGatewayCommandMock,
}));

describe("addGatewayRunCommand", () => {
  beforeEach(() => {
    runGatewayCommandMock.mockClear();
  });

  it("consumes an injected prepared runtime after preflight", async () => {
    const order: string[] = [];
    const loadRuntime = vi.fn(async () => {
      order.push("runtime");
      return { runGatewayCommand: runGatewayCommandMock };
    });
    const program = new Command();
    addGatewayRunCommand(program.command("gateway"), {
      beforeRun: async () => {
        order.push("preflight");
      },
      loadRuntime,
    });

    await program.parseAsync(["gateway"], { from: "user" });

    expect(order).toEqual(["preflight", "runtime"]);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(runGatewayCommandMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the default runtime import for callers without a prepared module", async () => {
    const program = new Command();
    addGatewayRunCommand(program.command("gateway"));

    await program.parseAsync(["gateway"], { from: "user" });

    expect(runGatewayCommandMock).toHaveBeenCalledTimes(1);
  });
});
