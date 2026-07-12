// Command group descriptor tests cover grouped CLI command metadata and help organization.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildCommandGroupEntries,
  defineImportedCommandGroupSpec,
  defineImportedProgramCommandGroupSpecs,
  resolveCommandGroupEntries,
} from "./command-group-descriptors.js";

const descriptors = [
  {
    name: "alpha",
    description: "Alpha command",
    hasSubcommands: false,
  },
  {
    name: "beta",
    description: "Beta command",
    hasSubcommands: true,
  },
] as const;

describe("command-group-descriptors", () => {
  it("resolves placeholders by descriptor name", () => {
    const register = vi.fn();
    expect(
      resolveCommandGroupEntries(descriptors, [{ commandNames: ["alpha"], register }]),
    ).toEqual([
      {
        placeholders: [descriptors[0]],
        register,
      },
    ]);
  });

  it("builds command-group entries with a register mapper", () => {
    const register = vi.fn();
    const mappedRegister = vi.fn();
    const entries = buildCommandGroupEntries(
      descriptors,
      [{ commandNames: ["beta"], register }],
      () => mappedRegister,
    );

    expect(entries).toEqual([
      {
        placeholders: [descriptors[1]],
        register: mappedRegister,
      },
    ]);
    expect(register).not.toHaveBeenCalled();
  });

  it("builds imported specs that lazy-load and register once", async () => {
    const module = { register: vi.fn() };
    const loadModule = vi.fn(async () => module);
    const spec = defineImportedCommandGroupSpec(["alpha"], loadModule, (loaded, args: string) => {
      loaded.register(args);
    });

    await spec.register("ok");

    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(module.register).toHaveBeenCalledWith("ok");
  });

  it("builds multiple program-only imported specs from definition arrays", async () => {
    const alpha = { registerAlpha: vi.fn() };
    const beta = { registerBeta: vi.fn() };
    const specs = defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["alpha"],
        loadModule: async () => alpha,
        exportName: "registerAlpha",
      },
      {
        commandNames: ["beta"],
        loadModule: async () => beta,
        exportName: "registerBeta",
      },
    ]);

    await expectDefined(specs[0], "specs[0] test invariant").register("program-one" as never);
    await expectDefined(specs[1], "specs[1] test invariant").register("program-two" as never);

    expect(alpha.registerAlpha).toHaveBeenCalledWith("program-one");
    expect(beta.registerBeta).toHaveBeenCalledWith("program-two");
  });
});
