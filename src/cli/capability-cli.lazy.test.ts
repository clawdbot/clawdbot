import { Command } from "commander";
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => {
  const modules = new Set<string>();
  return {
    modules,
    mock(name: string, exportName: string) {
      modules.add(name);
      return { [exportName]: vi.fn() };
    },
  };
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

it("loads only the selected capability command domain", async () => {
  const { registerCapabilityCli } = await import("./capability-cli.js");
  const metadataProgram = new Command();

  await registerCapabilityCli(metadataProgram, ["node", "openclaw", "infer", "list", "--json"]);

  const capability = metadataProgram.commands.find((command) => command.name() === "infer");
  expect(capability?.commands.map((command) => command.name())).toEqual(["list", "inspect"]);
  expect(loaded.modules).toEqual(new Set());

  await registerCapabilityCli(new Command(), [
    "node",
    "openclaw",
    "infer",
    "image",
    "providers",
    "--json",
  ]);

  expect(loaded.modules).toEqual(new Set(["image"]));
});
