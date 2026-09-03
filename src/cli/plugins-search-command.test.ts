// Plugins search command tests cover plugin search command registration and results.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn((value: string) =>
      logs.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    ),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    logs,
    errors,
    runtime,
    searchClawHubPackages: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../infra/clawhub-packages.js", () => ({
  searchClawHubPackages: mocks.searchClawHubPackages,
}));

const { runPluginsSearchCommand } = await import("./plugins-search-command.js");
const { registerPluginsCli } = await import("./plugins-cli.js");

describe("plugins search command", () => {
  beforeEach(() => {
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.searchClawHubPackages.mockReset();
  });

  it.each([
    {
      context: "default",
      profile: undefined,
      container: undefined,
      command: "openclaw plugins install clawhub:openclaw-calendar",
    },
    {
      context: "profile",
      profile: "work",
      container: undefined,
      command: "openclaw --profile work plugins install clawhub:openclaw-calendar",
    },
    {
      context: "container",
      profile: undefined,
      container: "staging",
      command: "openclaw --container staging plugins install clawhub:openclaw-calendar",
    },
    {
      context: "container over profile",
      profile: "work",
      container: "staging",
      command: "openclaw --container staging plugins install clawhub:openclaw-calendar",
    },
  ])("searches ClawHub plugin families with the $context install context", async (scenario) => {
    mocks.searchClawHubPackages
      .mockResolvedValueOnce([
        {
          score: 12,
          package: {
            name: "openclaw-calendar",
            displayName: "Calendar",
            family: "code-plugin",
            channel: "community",
            isOfficial: false,
            summary: "Calendar sync",
            createdAt: 1,
            updatedAt: 1,
            latestVersion: "1.2.3",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          score: 10,
          package: {
            name: "openclaw-calendar-bundle",
            displayName: "Calendar Bundle",
            family: "bundle-plugin",
            channel: "official",
            isOfficial: true,
            summary: "Calendar bundle",
            createdAt: 1,
            updatedAt: 1,
            latestVersion: "2.0.0",
          },
        },
      ]);

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: scenario.profile,
        OPENCLAW_CONTAINER_HINT: scenario.container,
      },
      () => runPluginsSearchCommand(["calendar"], { limit: 5 }, mocks.runtime),
    );

    expect(mocks.searchClawHubPackages).toHaveBeenCalledWith({
      query: "calendar",
      family: "code-plugin",
      limit: 5,
    });
    expect(mocks.searchClawHubPackages).toHaveBeenCalledWith({
      query: "calendar",
      family: "bundle-plugin",
      limit: 5,
    });
    expect(mocks.logs.join("\n")).toContain("openclaw-calendar");
    expect(mocks.logs.join("\n")).toContain(`Install: ${scenario.command}`);
  });

  it("writes JSON results when requested", async () => {
    mocks.searchClawHubPackages.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await runPluginsSearchCommand("calendar", { json: true }, mocks.runtime);

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({ results: [] }, 2);
  });

  it("leaves missing-query JSON failures to the root renderer", async () => {
    await expect(runPluginsSearchCommand([], { json: true }, mocks.runtime)).rejects.toThrow(
      "Usage: openclaw plugins search <query>",
    );

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("leaves ClawHub JSON failures to the root renderer", async () => {
    mocks.searchClawHubPackages.mockRejectedValueOnce(new Error("offline fixture"));

    await expect(
      runPluginsSearchCommand("calendar", { json: true }, mocks.runtime),
    ).rejects.toThrow("offline fixture");

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects partial numeric search limits", async () => {
    const program = new Command();
    program.exitOverride();
    registerPluginsCli(program);

    await expect(
      program.parseAsync(["plugins", "search", "calendar", "--limit", "10ms"], { from: "user" }),
    ).rejects.toThrow("--limit must be a positive integer.");
    expect(mocks.searchClawHubPackages).not.toHaveBeenCalled();
  });
});
