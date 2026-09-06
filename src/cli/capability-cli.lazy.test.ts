import { Command } from "commander";
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => {
  const modules = new Set<string>();
  return {
    modules,
    mock(name: string, exportName: string) {
      modules.add(name);
      return {
        [exportName]: (capability: Command) => capability.command(name).description(name),
      };
    },
  };
});

vi.mock("../agents/auth-profiles.js", () => {
  throw new Error("Inference metadata must not import provider auth runtime");
});

vi.mock("./capability-cli/audio.js", () => loaded.mock("audio", "registerAudioCapabilityCommands"));
vi.mock("./capability-cli/embedding.js", () =>
  loaded.mock("embedding", "registerEmbeddingCapabilityCommands"),
);
vi.mock("./capability-cli/image.js", () => loaded.mock("image", "registerImageCapabilityCommands"));
vi.mock("./capability-cli/model.js", () => loaded.mock("model", "registerModelCapabilityCommands"));
vi.mock("./capability-cli/tts.js", () => loaded.mock("tts", "registerTtsCapabilityCommands"));
vi.mock("./capability-cli/video.js", () => loaded.mock("video", "registerVideoCapabilityCommands"));
vi.mock("./capability-cli/web.js", () => loaded.mock("web", "registerWebCapabilityCommands"));

it("keeps metadata and selected-domain help behind the inference import boundary", async () => {
  const { registerCapabilityCli } = await import("./capability-cli.js");
  for (const args of [
    ["infer", "list", "--json"],
    ["capability", "inspect", "--name", "image.generate", "--help"],
  ]) {
    const metadataProgram = new Command().enablePositionalOptions();
    await registerCapabilityCli(metadataProgram, ["node", "openclaw", ...args]);
    const capability = metadataProgram.commands.find((command) => command.name() === "infer");
    expect(capability?.commands.map((command) => command.name())).toEqual(["list", "inspect"]);
    expect(loaded.modules).toEqual(new Set());
  }

  await registerCapabilityCli(new Command(), [
    "node",
    "openclaw",
    "infer",
    "--log-level",
    "debug",
    "image",
    "providers",
  ]);

  expect(loaded.modules).toEqual(new Set(["image"]));
});

const allDomains = ["model", "image", "audio", "tts", "video", "web", "embedding"];

it.each([
  { args: ["infer", "--help"], domains: allDomains },
  { args: ["infer", "--help", "image"], domains: allDomains },
  { args: ["infer", "--bad", "image", "--help"], domains: allDomains },
  { args: ["infer", "imgae"], domains: allDomains },
  { args: ["infer", "help", "image"], domains: allDomains },
  { args: ["completion", "--shell", "image"], domains: allDomains },
  { args: ["infer", "--", "image"], domains: allDomains },
  { args: ["infer", "--", "--log-level", "debug", "image"], domains: allDomains },
  { args: ["--", "infer", "image", "providers"], domains: ["image"] },
  { args: ["--", "infer", "--log-level", "debug", "image"], domains: allDomains },
  { args: ["--profile", "image", "infer", "list", "--help"], domains: [] },
  { args: ["infer", "--log-level", "debug", "list", "--json"], domains: [] },
  { args: ["infer", "--log-level", "debug", "image", "providers"], domains: ["image"] },
  { args: ["capability", "--log-level=debug", "image", "--help"], domains: ["image"] },
  { args: ["infer", "--log-level", "--help", "image"], domains: allDomains },
  { args: ["infer", "--log-level=", "image", "--help"], domains: allDomains },
  { args: ["infer", "--log-level", "debug", "--help", "image"], domains: allDomains },
  { args: ["capability", "image", "--help"], domains: ["image"] },
  { args: ["infer", "image", "providers", "--json"], domains: ["image"] },
  { args: ["infer", "model", "run", "--prompt", "--help"], domains: ["model"] },
])("preserves the command inventory for $args", async ({ args, domains }) => {
  const { registerCapabilityCli } = await import("./capability-cli.js");
  const program = new Command().enablePositionalOptions();
  await registerCapabilityCli(program, ["node", "openclaw", ...args]);
  const capability = program.commands.find((command) => command.name() === "infer");
  expect(capability?.commands.map((command) => command.name())).toEqual([
    "list",
    "inspect",
    ...domains,
  ]);
});

it.each([
  ["--help", "image"],
  ["--bad", "image", "--help"],
  ["--log-level", "--help", "image"],
  ["--log-level=", "image", "--help"],
])("prints complete parent help when options precede the domain: %j", async (...args) => {
  const { registerCapabilityCli } = await import("./capability-cli.js");
  let output = "";
  const program = new Command()
    .name("openclaw")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (value) => (output += value) });
  await registerCapabilityCli(program, ["node", "openclaw", "infer", ...args]);
  await expect(program.parseAsync(["infer", ...args], { from: "user" })).rejects.toMatchObject({
    code: "commander.helpDisplayed",
    exitCode: 0,
  });
  for (const domain of allDomains) {
    expect(output).toContain(`${domain} `);
  }
});
