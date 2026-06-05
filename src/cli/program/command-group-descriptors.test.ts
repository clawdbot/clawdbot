// Command group descriptor tests cover grouped CLI command metadata and help organization.
import { describe, expect, it, vi } from "vitest";
import {
  buildCommandGroupEntries,
  defineImportedCommandGroupSpec,
  defineImportedCommandGroupSpecs,
  defineImportedProgramCommandGroupSpec,
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

  it("builds imported specs from definition arrays", async () => {
    const alpha = { registerAlpha: vi.fn() };
    const beta = { registerBeta: vi.fn() };
    const specs = defineImportedCommandGroupSpecs<string, typeof alpha | typeof beta>([
      {
        commandNames: ["alpha"],
        loadModule: async () => alpha,
        register: (loaded, value) => {
          if ("registerAlpha" in loaded) {
            loaded.registerAlpha(value);
          }
        },
      },
      {
        commandNames: ["beta"],
        loadModule: async () => beta,
        register: (loaded, value) => {
          if ("registerBeta" in loaded) {
            loaded.registerBeta(value);
          }
        },
      },
    ]);

    await specs[0].register("one");
    await specs[1].register("two");

    expect(alpha.registerAlpha).toHaveBeenCalledWith("one");
    expect(beta.registerBeta).toHaveBeenCalledWith("two");
  });

  it("builds program-only imported specs from exported registrar names", async () => {
    const module = { registerAlpha: vi.fn() };
    const spec = defineImportedProgramCommandGroupSpec({
      commandNames: ["alpha"],
      loadModule: async () => module,
      exportName: "registerAlpha",
    });

    await spec.register("program" as never);

    expect(module.registerAlpha).toHaveBeenCalledWith("program");
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

    await specs[0].register("program-one" as never);
    await specs[1].register("program-two" as never);

    expect(alpha.registerAlpha).toHaveBeenCalledWith("program-one");
    expect(beta.registerBeta).toHaveBeenCalledWith("program-two");
  });
});
