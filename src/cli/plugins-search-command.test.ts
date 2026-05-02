import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../infra/clawhub.js", () => ({
  searchClawHubPackages: mocks.searchClawHubPackages,
}));

const { runPluginsSearchCommand } = await import("./plugins-search-command.js");

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

  it("searches ClawHub code and bundle plugin families", async () => {
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

    await runPluginsSearchCommand(["calendar"], { limit: 5 }, mocks.runtime);

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
    expect(mocks.logs.join("\n")).toContain(
      "Install: openclaw plugins install clawhub:openclaw-calendar",
    );
  });

  it("writes JSON results when requested", async () => {
    mocks.searchClawHubPackages.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await runPluginsSearchCommand("calendar", { json: true }, mocks.runtime);

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({ results: [] }, 2);
  });
});
