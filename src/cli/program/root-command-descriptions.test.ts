// Root help renders catalog placeholders while command help and completion use
// registered Commander commands. Keep those user-facing descriptions aligned.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCoreCliCommandNames, registerCoreCliByName } from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { registerSubCliByName } from "./register.subclis.js";
import { getSubCliEntries } from "./subcli-descriptors.js";

describe("root command descriptions", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps catalog placeholders and registered commands in sync", async () => {
    const program = new Command().name("openclaw");
    const ctx = createProgramContext();
    const argv = ["node", "openclaw", "completion"];

    for (const name of getCoreCliCommandNames()) {
      await registerCoreCliByName(program, ctx, name, argv);
    }
    for (const entry of getSubCliEntries()) {
      await registerSubCliByName(program, entry.name, argv, { purpose: "completion" });
    }

    const registeredCommands = new Map<string, { command: Command; registeredAsAlias: boolean }>();
    for (const command of program.commands) {
      registeredCommands.set(command.name(), { command, registeredAsAlias: false });
      for (const alias of command.aliases()) {
        registeredCommands.set(alias, { command, registeredAsAlias: true });
      }
    }

    const descriptors = [...getCoreCliCommandDescriptors(), ...getSubCliEntries()];
    const missing: string[] = [];
    const mismatches: string[] = [];
    for (const descriptor of descriptors) {
      const registered = registeredCommands.get(descriptor.name);
      if (!registered) {
        missing.push(descriptor.name);
        continue;
      }
      if (
        !registered.registeredAsAlias &&
        registered.command.description() !== descriptor.description
      ) {
        mismatches.push(
          `${descriptor.name}\n  catalog:    ${descriptor.description}\n  registered: ${registered.command.description()}`,
        );
      }
    }

    expect(missing, "catalog entries with no registered command or alias").toEqual([]);
    expect(mismatches, "root help vs registered command description drift").toEqual([]);
  });
});
