import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");
const { readCronTriggerScript } = await import("./trigger-options.js");

describe("cron trigger CLI options", () => {
  let fixtureRoot = "";

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-trigger-cli-"));
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("advertises every canonical thinking level on add and edit", () => {
    const program = new Command().exitOverride();
    registerCronAddCommand(program);
    registerCronEditCommand(program);

    for (const commandName of ["add", "edit"]) {
      const help = program.commands
        .find((command) => command.name() === commandName)
        ?.helpInformation();
      expect(help).toContain("off|minimal|low|medium|high|xhigh|adaptive|max|ultra");
    }
  });

  it("reads --trigger-script client-side and sends trigger metadata on add", async () => {
    const scriptPath = path.join(fixtureRoot, "watch.js");
    await fs.writeFile(scriptPath, "  json({ fire: true })  \n", "utf8");
    const program = new Command().exitOverride();
    registerCronAddCommand(program);

    await program.parseAsync(
      [
        "add",
        "--name",
        "watcher",
        "--every",
        "30s",
        "--trigger-script",
        scriptPath,
        "--trigger-once",
        "--system-event",
        "changed",
        "--session",
        "main",
      ],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ triggerScript: scriptPath, triggerOnce: true }),
      expect.objectContaining({
        trigger: { script: "json({ fire: true })", once: true },
      }),
    );
  });

  it("accepts trigger script files at the byte limit", async () => {
    const scriptPath = path.join(fixtureRoot, "at-limit.js");
    await fs.writeFile(scriptPath, "x".repeat(65_536), "utf8");

    await expect(readCronTriggerScript(scriptPath)).resolves.toHaveLength(65_536);
  });

  it("stops oversized trigger script files before the gateway call", async () => {
    const scriptPath = path.join(fixtureRoot, "oversized.js");
    await fs.writeFile(scriptPath, "x".repeat(65_537), "utf8");
    const program = new Command().exitOverride();
    registerCronAddCommand(program);
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    try {
      await expect(
        program.parseAsync(
          [
            "add",
            "--name",
            "oversized",
            "--every",
            "30s",
            "--trigger-script",
            scriptPath,
            "--system-event",
            "changed",
            "--session",
            "main",
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("exit:1");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Trigger script exceeds 65536 bytes"),
      );
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("maps --clear-trigger to a nullable edit patch", async () => {
    const program = new Command().exitOverride();
    registerCronEditCommand(program);

    await program.parseAsync(["edit", "job-1", "--clear-trigger"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearTrigger: true }),
      { id: "job-1", patch: { trigger: null } },
    );
  });
});
