import { vi } from "vitest";

export const pluginCommandMocks = {
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
};

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));

export function resetPluginCommandMocks() {
  pluginCommandMocks.getPluginCommandSpecs.mockClear();
  pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([]);
  pluginCommandMocks.matchPluginCommand.mockClear();
  pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
  pluginCommandMocks.executePluginCommand.mockClear();
  pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" });
}
