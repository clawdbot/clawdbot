import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import * as cliCoreApiModule from "./core-api.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
}));

vi.mock("../sdk-node-runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../sdk-node-runtime.js")>("../sdk-node-runtime.js");
  return {
    ...actual,
    callGatewayFromCli: gatewayMocks.callGatewayFromCli,
  };
});

const configMocks = vi.hoisted(() => {
  const loadConfig = vi.fn(() => ({ browser: {} }));
  return {
    getRuntimeConfig: loadConfig,
    loadConfig,
  };
});
vi.mock("../config/config.js", () => configMocks);

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (_opts: unknown, params: { path?: string; query?: Record<string, unknown> }) => {
      const format = params.query?.format === "aria" ? "aria" : "ai";
      if (format === "aria") {
        return {
          ok: true,
          format: "aria",
          targetId: "t1",
          url: "https://example.com",
          nodes: [],
        };
      }
      return {
        ok: true,
        format: "ai",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      };
    },
  ),
}));
vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(
  sharedMocks.callBrowserRequest,
);
vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockImplementation(configMocks.loadConfig);
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(runtime.writeJson);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit);

let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

type SnapshotDefaultsCase = {
  label: string;
  args: string[];
  expectMode: "efficient" | undefined;
};

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON output", false);
    registerBrowserInspectCommands(browser, () => ({}));
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return params as { path?: string; query?: Record<string, unknown> } | undefined;
  };

  const runSnapshot = async (args: string[]) => await runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    configMocks.loadConfig.mockReturnValue({ browser: {} });
  });

  it.each<SnapshotDefaultsCase>([
    {
      label: "uses config snapshot defaults when mode is not provided",
      args: [],
      expectMode: "efficient",
    },
    {
      label: "does not apply config snapshot defaults to aria snapshots",
      args: ["--format", "aria"],
      expectMode: undefined,
    },
    {
      label: "does not apply config snapshot defaults to explicit ai snapshots",
      args: ["--format", "ai"],
      expectMode: undefined,
    },
  ])("$label", async ({ args, expectMode }) => {
    configMocks.loadConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

    if (args.includes("--format") && args.includes("aria")) {
      gatewayMocks.callGatewayFromCli.mockResolvedValueOnce({
        ok: true,
        format: "aria",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      });
    }

    const params = await runSnapshot(args);
    expect(params?.path).toBe("/snapshot");
    if (expectMode === undefined) {
      expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
    } else {
      expect(params?.query?.format).toBe("ai");
      expect(params?.query?.mode).toBe(expectMode);
    }
  });

  it("does not set mode when config defaults are absent", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot([]);
    expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
  });

  it("applies explicit efficient mode without config defaults", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot(["--efficient"]);
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.mode).toBe("efficient");
  });

  it("passes URL expansion for snapshots", async () => {
    const params = await runSnapshot(["--urls"]);
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.urls).toBe(true);
  });

  it("sends screenshot request with trimmed target id and jpeg type", async () => {
    const params = await runBrowserInspect(["screenshot", " tab-1 ", "--type", "jpeg"], true);
    expect(params?.path).toBe("/screenshot");
    const body = (params as { body?: Record<string, unknown> } | undefined)?.body;
    expect(body?.targetId).toBe("tab-1");
    expect(body?.type).toBe("jpeg");
    expect(body?.fullPage).toBe(false);
  });

  it("passes screenshot labels", async () => {
    const params = await runBrowserInspect(["screenshot", "tab-1", "--labels"], true);
    expect(params?.path).toBe("/screenshot");
    const body = (params as { body?: Record<string, unknown> } | undefined)?.body;
    expect(body?.targetId).toBe("tab-1");
    expect(body?.labels).toBe(true);
  });
});
