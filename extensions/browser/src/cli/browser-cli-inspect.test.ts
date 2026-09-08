// Browser tests cover browser cli inspect plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import * as cliCoreApiModule from "./core-api.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ browser: {} })),
}));

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
let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;
let inspectSpies: Array<{ mockRestore(): void }> = [];

type SnapshotDefaultsCase = {
  label: string;
  args: string[];
  expectMode: "efficient" | undefined;
};

function restoreInspectSpies() {
  for (const spy of inspectSpies.toReversed()) {
    spy.mockRestore();
  }
  inspectSpies = [];
}

function installInspectSpies() {
  restoreInspectSpies();
  inspectSpies = [
    vi
      .spyOn(browserCliSharedModule, "callBrowserRequest")
      .mockImplementation(sharedMocks.callBrowserRequest),
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockImplementation(configMocks.getRuntimeConfig),
    vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log),
    vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(runtime.writeJson),
    vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(runtime.error),
    vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit),
  ];
}

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command().enablePositionalOptions();
    const browser = program
      .command("browser")
      .option("--json", "JSON output", false)
      .option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserInspectCommands(browser, (cmd) => cmd.parent?.opts() ?? {});
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return params as { path?: string; query?: Record<string, unknown> } | undefined;
  };

  const runSnapshot = async (args: string[]) => await runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    installInspectSpies();
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  beforeEach(() => {
    installInspectSpies();
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreInspectSpies();
    resetRuntimeCapture();
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
  });

  it.each([
    {
      command: "screenshot",
      requestPath: "/screenshot",
      args: ["screenshot"],
      timeout: "30000",
      ownerTimeoutMs: undefined,
    },
    {
      command: "screenshot",
      requestPath: "/screenshot",
      args: ["--timeout", "60000", "screenshot"],
      timeout: "60000",
      ownerTimeoutMs: 60000,
    },
    {
      command: "screenshot",
      requestPath: "/screenshot",
      args: ["screenshot", "tab-42", "--timeout", "60000"],
      timeout: "60000",
      ownerTimeoutMs: 60000,
      targetId: "tab-42",
    },
    {
      command: "screenshot",
      requestPath: "/screenshot",
      args: ["--timeout", "60000", "screenshot", "--timeout", "90000"],
      timeout: "90000",
      ownerTimeoutMs: 90000,
    },
    {
      command: "snapshot",
      requestPath: "/snapshot",
      args: ["snapshot"],
      timeout: "30000",
      ownerTimeoutMs: undefined,
    },
    {
      command: "snapshot",
      requestPath: "/snapshot",
      args: ["--timeout", "60000", "snapshot"],
      timeout: "60000",
      ownerTimeoutMs: 60000,
    },
    {
      command: "snapshot",
      requestPath: "/snapshot",
      args: ["snapshot", "--timeout", "60000"],
      timeout: "60000",
      ownerTimeoutMs: 60000,
    },
    {
      command: "snapshot",
      requestPath: "/snapshot",
      args: ["--timeout", "60000", "snapshot", "--timeout", "90000"],
      timeout: "90000",
      ownerTimeoutMs: 90000,
    },
  ])(
    "keeps the gateway and $command owner on the explicit $timeout ms timeout",
    async ({ command, requestPath, args, timeout, ownerTimeoutMs, targetId }) => {
      await runBrowserInspect(args, true);

      expect(sharedMocks.callBrowserRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout }),
        expect.objectContaining({ path: requestPath }),
      );
      const [, request] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
      const payload = request as {
        query?: { timeoutMs?: number };
        body?: { timeoutMs?: number; targetId?: string };
      };
      const ownerPayload = command === "snapshot" ? payload.query : payload.body;
      expect(ownerPayload?.timeoutMs).toBe(ownerTimeoutMs);
      if (ownerTimeoutMs === undefined) {
        expect(ownerPayload).not.toHaveProperty("timeoutMs");
      }
      if (targetId !== undefined) {
        expect(payload.body?.targetId).toBe(targetId);
      }
    },
  );

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
    configMocks.getRuntimeConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

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
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot([]);
    expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
  });

  it("applies explicit efficient mode without config defaults", async () => {
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot(["--efficient"]);
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.mode).toBe("efficient");
  });

  it("passes URL expansion for snapshots", async () => {
    const params = await runSnapshot(["--urls"]);
    expect(params?.query?.format).toBe("ai");
    expect(params?.query?.urls).toBe(true);
  });

  it("rejects non-integer snapshot numeric options before dispatch", async () => {
    await expect(runSnapshot(["--limit", "1e3"])).rejects.toThrow("__exit__:1");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "Invalid --limit: must be an integer >= 1",
    );

    resetRuntimeCapture();
    await expect(runSnapshot(["--depth", "-1"])).rejects.toThrow("__exit__:1");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "Invalid --depth: must be an integer >= 0",
    );

    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("passes zero snapshot depth because root depth is valid", async () => {
    const params = await runSnapshot(["--depth", "0"]);
    expect(params?.query?.depth).toBe(0);
  });

  it("accepts signed decimal snapshot numeric options", async () => {
    const params = await runSnapshot(["--limit", "+10", "--depth", "+0"]);
    expect(params?.query?.limit).toBe(10);
    expect(params?.query?.depth).toBe(0);
  });

  it.each([
    {
      args: ["screenshot", "tab-1", "--type", "webp"],
      error: "Invalid --type: expected png or jpeg",
    },
    {
      args: ["snapshot", "--format", "html"],
      error: "Invalid --format: expected aria or ai",
    },
    {
      args: ["snapshot", "--mode", "full"],
      error: "Invalid --mode: expected efficient",
    },
  ])("rejects unsupported inspect option values before dispatch", async ({ args, error }) => {
    await expect(runBrowserInspect(args)).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(error);
    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
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

  it.each([
    { label: "AI", args: [] },
    { label: "ARIA", args: ["--format", "aria"] },
  ])("keeps an existing $label snapshot when publication fails", async ({ args }) => {
    const tempDir = fsSync.mkdtempSync(path.join(tmpdir(), "openclaw-browser-snapshot-"));
    try {
      const outputPath = path.join(tempDir, "snapshot.txt");
      fsSync.writeFileSync(outputPath, "previous snapshot\n");
      const priorBytes = fsSync.readFileSync(outputPath);

      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        expect(typeof file).toBe("string");
        fsSync.writeFileSync(file as string, "partial replacement");
        throw new Error("injected snapshot write failure");
      });
      try {
        await expect(runSnapshot([...args, "--out", outputPath])).rejects.toThrow("__exit__:1");
      } finally {
        writeSpy.mockRestore();
      }

      expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("injected snapshot write failure");
      expect(fsSync.readFileSync(outputPath)).toEqual(priorBytes);
      expect(fsSync.readdirSync(tempDir)).toEqual(["snapshot.txt"]);
    } finally {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
