import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  firstWrittenJsonArg,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "../../../src/cli/test-runtime-capture.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
);

vi.mock("./cli.host.runtime.js", async () => {
  const [runtimeCli, runtimeCore, runtimeFiles] = await Promise.all([
    import("openclaw/plugin-sdk/memory-core-host-runtime-cli"),
    import("openclaw/plugin-sdk/memory-core-host-runtime-core"),
    import("openclaw/plugin-sdk/memory-core-host-runtime-files"),
  ]);
  return {
    colorize: runtimeCli.colorize,
    defaultRuntime: runtimeCli.defaultRuntime,
    formatErrorMessage: runtimeCli.formatErrorMessage,
    getMemorySearchManager,
    isRich: runtimeCli.isRich,
    listMemoryFiles: runtimeFiles.listMemoryFiles,
    loadConfig,
    normalizeExtraMemoryPaths: runtimeFiles.normalizeExtraMemoryPaths,
    resolveCommandSecretRefsViaGateway,
    resolveDefaultAgentId,
    resolveSessionTranscriptsDirForAgent: runtimeCore.resolveSessionTranscriptsDirForAgent,
    resolveStateDir: runtimeCore.resolveStateDir,
    setVerbose: runtimeCli.setVerbose,
    shortenHomeInString: runtimeCli.shortenHomeInString,
    shortenHomePath: runtimeCli.shortenHomePath,
    theme: runtimeCli.theme,
    withManager: runtimeCli.withManager,
    withProgress: runtimeCli.withProgress,
    withProgressTotals: runtimeCli.withProgressTotals,
  };
});

let registerMemoryCli: typeof import("./cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;
let isVerbose: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").isVerbose;
let setVerbose: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").setVerbose;
let fixtureRoot = "";
let workspaceFixtureRoot = "";
let qmdFixtureRoot = "";
let workspaceCaseId = 0;
let qmdCaseId = 0;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./cli.js"));
  ({ defaultRuntime, isVerbose, setVerbose } =
    await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-fixtures-"));
  workspaceFixtureRoot = path.join(fixtureRoot, "workspace");
  qmdFixtureRoot = path.join(fixtureRoot, "qmd");
  await fs.mkdir(workspaceFixtureRoot, { recursive: true });
  await fs.mkdir(qmdFixtureRoot, { recursive: true });
});

beforeEach(() => {
  getMemorySearchManager.mockReset();
  loadConfig.mockReset().mockReturnValue({});
  resolveDefaultAgentId.mockReset().mockReturnValue("main");
  resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  setVerbose(false);
});

afterAll(async () => {
  if (!fixtureRoot) {
    return;
  }
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("memory cli", () => {
  const inactiveMemorySecretDiagnostic = "agents.defaults.memorySearch.remote.apiKey inactive"; // pragma: allowlist secret

  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  function setupMemoryStatusWithInactiveSecretDiagnostics(close: ReturnType<typeof vi.fn>) {
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {},
      diagnostics: [inactiveMemorySecretDiagnostic] as string[],
    });
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });
  }

  function hasLoggedInactiveSecretDiagnostic(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.some(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes(inactiveMemorySecretDiagnostic),
    );
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  function captureHelpOutput(command: Command | undefined) {
    let output = "";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      command?.outputHelp();
      return output;
    } finally {
      writeSpy.mockRestore();
    }
  }

  function getMemoryHelpText() {
    const program = new Command();
    registerMemoryCli(program);
    const memoryCommand = program.commands.find((command) => command.name() === "memory");
    return captureHelpOutput(memoryCommand);
  }

  async function withQmdIndexDb(content: string, run: (dbPath: string) => Promise<void>) {
    const dbPath = path.join(qmdFixtureRoot, `case-${qmdCaseId++}.sqlite`);
    await fs.writeFile(dbPath, content, "utf-8");
    await run(dbPath);
  }

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(workspaceFixtureRoot, `case-${workspaceCaseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<void> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("resolves configured memory SecretRefs through gateway snapshot", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
            },
          },
        },
      },
    });
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status"]);

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "memory status",
        targetIds: new Set([
          "agents.defaults.memorySearch.remote.apiKey",
          "agents.list[].memorySearch.remote.apiKey",
        ]),
      }),
    );
  });

  it("logs gateway secret diagnostics for non-json status output", async () => {
    const close = vi.fn(async () => {});
    setupMemoryStatusWithInactiveSecretDiagnostics(close);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(hasLoggedInactiveSecretDiagnostic(log)).toBe(true);
  });

  it("documents memory help examples", () => {
    const helpText = getMemoryHelpText();

    expect(helpText).toContain("openclaw memory status --fix");
    expect(helpText).toContain("Repair stale recall locks and normalize promotion metadata.");
    expect(helpText).toContain("openclaw memory status --deep");
    expect(helpText).toContain("Probe embedding provider readiness.");
    expect(helpText).toContain('openclaw memory search "meeting notes"');
    expect(helpText).toContain("Quick search using positional query.");
    expect(helpText).toContain('openclaw memory search --query "deployment" --max-results 20');
    expect(helpText).toContain("Limit results for focused troubleshooting.");
    expect(helpText).toContain("openclaw memory promote --apply");
    expect(helpText).toContain("Append top-ranked short-term candidates into MEMORY.md.");
    expect(helpText).toContain('openclaw memory promote-explain "router vlan"');
    expect(helpText).toContain("Explain why a specific candidate would or would not promote.");
    expect(helpText).toContain("openclaw memory rem-harness --json");
    expect(helpText).toContain(
      "Preview REM reflections, candidate truths, and deep promotion output.",
    );
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("prints recall-store audit details during status", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router vlan",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 3,
            score: 0.93,
            snippet: "Configured router VLAN 10 for IoT clients.",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["status"]);

      expect(log).toHaveBeenCalledWith(expect.stringContaining("Recall store: 1 entries"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Dreaming: off"));
      expect(close).toHaveBeenCalled();
    });
  });

  it("reports dreaming blocked when another explicit heartbeat agent excludes main", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "ops",
            heartbeat: {
              every: "1h",
            },
          },
        ],
      },
    });
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: "/tmp/openclaw" }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dreaming status: blocked - dreaming is enabled but will not run because heartbeat is disabled for "main". See https://docs.openclaw.ai/concepts/dreaming#troubleshooting',
      ),
    );
    expect(close).toHaveBeenCalled();
  });

  it('reports dreaming blocked when main heartbeat interval is "0m"', async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
        },
        list: [{ id: "main", default: true }],
      },
    });
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: "/tmp/openclaw" }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dreaming status: blocked - dreaming is enabled but will not run because heartbeat is disabled for "main". See https://docs.openclaw.ai/concepts/dreaming#troubleshooting',
      ),
    );
    expect(close).toHaveBeenCalled();
  });

  it("reports dreaming blocked for the configured default agent when it is not main", async () => {
    resolveDefaultAgentId.mockReturnValue("ops");
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "0m",
          },
        },
        list: [{ id: "ops", default: true }],
      },
    });
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: "/tmp/openclaw" }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--agent", "ops"]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dreaming status: blocked - dreaming is enabled but will not run because heartbeat is disabled for "ops". See https://docs.openclaw.ai/concepts/dreaming#troubleshooting',
      ),
    );
    expect(close).toHaveBeenCalled();
  });

  it("repairs invalid recall metadata and stale locks with status --fix", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              good: {
                key: "good",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 2,
                source: "memory",
                snippet: "QMD router cache note",
                recallCount: 1,
                totalScore: 0.8,
                maxScore: 0.8,
                firstRecalledAt: "2026-04-04T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a"],
              },
              bad: {
                path: "",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      await fs.writeFile(lockPath, "999999:0\n", "utf-8");
      const staleMtime = new Date(Date.now() - 120_000);
      await fs.utimes(lockPath, staleMtime, staleMtime);

      const close = vi.fn(async () => {});
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["status", "--fix"]);

      expect(log).toHaveBeenCalledWith(expect.stringContaining("Repair: rewrote store"));
      await expect(fs.stat(lockPath)).rejects.toThrow();
      const repaired = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        entries: Record<string, { conceptTags?: string[] }>;
      };
      expect(repaired.entries.good?.conceptTags).toContain("router");
      expect(close).toHaveBeenCalled();
    });
  });

  it("shows the fix hint only before --fix has been run", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      await fs.writeFile(storePath, " \n", "utf-8");

      const close = vi.fn(async () => {});
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["status"]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Fix: openclaw memory status --fix --agent main"),
      );

      log.mockClear();
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });
      await runMemoryCli(["status", "--fix"]);
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining("Fix: openclaw memory status --fix --agent main"),
      );
    });
  });

  it("repairs contaminated dreaming artifacts during status --fix", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
      await fs.mkdir(sessionCorpusDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionCorpusDir, "2026-04-11.txt"),
        [
          "[main/dreaming-main.jsonl#L3] ordinary session line",
          "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
        ].join("\n"),
        "utf-8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
        JSON.stringify({ version: 3, files: {}, seenMessages: {} }, null, 2),
        "utf-8",
      );
      await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf-8");

      const close = vi.fn(async () => {});
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["status", "--fix"]);

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Dream repair: archived session corpus"),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Dream archive:"));
      await expect(fs.access(sessionCorpusDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.access(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).resolves.toContain(
        "# Dream Diary",
      );
      expect(close).toHaveBeenCalled();
    });
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, status: () => makeMemoryStatus(), close });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("warns on stderr when index completes without sqlite-vec embeddings", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({
      sync,
      status: () =>
        makeMemoryStatus({
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(error).toHaveBeenCalledWith(
      "Memory index WARNING (main): chunks_vec not updated — sqlite-vec unavailable: load failed. Vector recall degraded.",
    );
    expect(close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("logs qmd index file path and size after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD index: "));
      expect(log).toHaveBeenCalledWith("Memory index updated (main).");
      expect(close).toHaveBeenCalled();
    });
  });

  it("surfaces qmd audit details in status output", async () => {
    const close = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () =>
          makeMemoryStatus({
            backend: "qmd",
            provider: "qmd",
            model: "qmd",
            requestedProvider: "qmd",
            dbPath,
            custom: {
              qmd: {
                collections: 2,
              },
            },
          }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["status"]);

      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD audit:"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("2 collections"));
      expect(close).toHaveBeenCalled();
    });
  });

  it("fails index when qmd db file is empty", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const error = spyRuntimeErrors(defaultRuntime);
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Memory index failed (main): QMD index file is empty"),
      );
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync, status: () => makeMemoryStatus() },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });

  it("prints status json output when requested", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["status", "--json"]);

    const payload = firstWrittenJsonArg<unknown[]>(writeJson);
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error("expected json payload");
    }
    expect(Array.isArray(payload)).toBe(true);
    expect((payload[0] as Record<string, unknown>)?.agentId).toBe("main");
    expect(close).toHaveBeenCalled();
  });

  it("routes gateway secret diagnostics to stderr for json status output", async () => {
    const close = vi.fn(async () => {});
    setupMemoryStatusWithInactiveSecretDiagnostics(close);

    const writeJson = spyRuntimeJson(defaultRuntime);
    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["status", "--json"]);

    const payload = firstWrittenJsonArg<unknown[]>(writeJson);
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error("expected json payload");
    }
    expect(Array.isArray(payload)).toBe(true);
    expect(hasLoggedInactiveSecretDiagnostic(error)).toBe(true);
  });

  it("logs default message when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValueOnce({ manager: null });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith("Memory search disabled.");
  });

  it("logs backend unsupported message when index has no sync", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () => makeMemoryStatus(),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index"]);

    expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
    expect(close).toHaveBeenCalled();
  });

  it("prints no matches for empty search results", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["search", "hello"]);

    expect(search).toHaveBeenCalledWith("hello", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:main:cli:direct:memory-search",
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
  });

  it("accepts --query for memory search", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["search", "--query", "deployment notes"]);

    expect(search).toHaveBeenCalledWith("deployment notes", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:main:cli:direct:memory-search",
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prefers --query when positional and flag are both provided", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["search", "positional", "--query", "flagged"]);

    expect(search).toHaveBeenCalledWith("flagged", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:main:cli:direct:memory-search",
    });
    expect(close).toHaveBeenCalled();
  });

  it("fails when neither positional query nor --query is provided", async () => {
    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["search"]);

    expect(error).toHaveBeenCalledWith(
      "Missing search query. Provide a positional query or use --query <text>.",
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints search results as json when requested", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    mockManager({ search, close });

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["search", "hello", "--json"]);

    const payload = firstWrittenJsonArg<{ results: unknown[] }>(writeJson);
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error("expected json payload");
    }
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results).toHaveLength(1);
    expect(close).toHaveBeenCalled();
  });

  it("prints no candidates when promote has no short-term recall data", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["promote"]);

      expect(log).toHaveBeenCalledWith("No short-term recall candidates.");
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("prints promote candidates as json", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router notes",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 4,
            endLine: 8,
            score: 0.86,
            snippet: "Configured VLAN 10 for IoT on router",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli([
        "promote",
        "--json",
        "--min-score",
        "0",
        "--min-recall-count",
        "0",
        "--min-unique-queries",
        "0",
      ]);

      const payload = firstWrittenJsonArg<{ candidates: unknown[] }>(writeJson);
      expect(payload).not.toBeNull();
      if (!payload) {
        throw new Error("expected json payload");
      }
      expect(Array.isArray(payload.candidates)).toBe(true);
      expect(payload.candidates).toHaveLength(1);
      expect(close).toHaveBeenCalled();
    });
  });

  it("explains a specific promote candidate as json", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router notes",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 4,
            endLine: 8,
            score: 0.86,
            snippet: "Configured VLAN 10 for IoT on router",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["promote-explain", "router", "--json", "--include-promoted"]);

      const payload = firstWrittenJsonArg<{ candidate?: { snippet?: string } }>(writeJson);
      expect(payload?.candidate?.snippet).toContain("Configured VLAN 10");
      expect(close).toHaveBeenCalled();
    });
  });

  it("previews rem harness output as json", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.now();
      const isoDay = new Date(nowMs).toISOString().slice(0, 10);
      await recordShortTermRecalls({
        workspaceDir,
        query: "weather plans",
        nowMs,
        results: [
          {
            path: `memory/${isoDay}.md`,
            startLine: 2,
            endLine: 3,
            score: 0.92,
            snippet: "Always check weather before suggesting outdoor plans.",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json"]);

      const payload = firstWrittenJsonArg<{
        rem?: { candidateTruths?: Array<{ snippet?: string }> };
        deep?: { candidates?: Array<{ snippet?: string }> };
      }>(writeJson);
      expect(payload?.rem?.candidateTruths?.[0]?.snippet).toContain("Always check weather");
      expect(payload?.deep?.candidates?.[0]?.snippet).toContain("Always check weather");
      expect(close).toHaveBeenCalled();
    });
  });

  it("previews rem harness output from a historical daily file path", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-01-01.md");
      await fs.writeFile(
        historyPath,
        [
          "# Preferences Learned",
          '- Always use "Happy Together" calendar for flights and reservations.',
          "- Calendar ID: udolnrooml2f2ha8jaio24v1r8@group.calendar.google.com",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json", "--path", historyPath]);

      const payload = firstWrittenJsonArg<{
        sourcePath?: string | null;
        sourceFiles?: string[];
        historicalImport?: { importedFileCount?: number; importedSignalCount?: number } | null;
        rem?: { candidateTruths?: Array<{ snippet?: string }> };
        deep?: { candidates?: Array<{ snippet?: string; path?: string }> };
      }>(writeJson);
      expect(payload?.sourcePath).toBe(historyPath);
      expect(payload?.sourceFiles).toEqual([historyPath]);
      expect(payload?.historicalImport?.importedFileCount).toBe(1);
      expect(payload?.historicalImport?.importedSignalCount).toBeGreaterThan(0);
      expect(Array.isArray(payload?.rem?.candidateTruths)).toBe(true);
      expect(payload?.deep?.candidates?.[0]?.snippet).toContain("Happy Together");
      expect(payload?.deep?.candidates?.[0]?.path).toBe("memory/2025-01-01.md");
      expect(close).toHaveBeenCalled();
    });
  });

  it("previews grounded rem output from a historical daily file path", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-01-01.md");
      await fs.writeFile(
        historyPath,
        [
          "## Preferences Learned",
          '- Always use "Happy Together" calendar for flights and reservations.',
          "- Calendar ID: udolnrooml2f2ha8jaio24v1r8@group.calendar.google.com",
          "",
          "## Setup",
          "- Set up Gmail access via gog.",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json", "--grounded", "--path", historyPath]);

      const payload = firstWrittenJsonArg<{
        grounded?: {
          scannedFiles?: number;
          files?: Array<{
            path?: string;
            renderedMarkdown?: string;
            memoryImplications?: Array<{ text?: string }>;
          }>;
        } | null;
      }>(writeJson);
      expect(payload?.grounded?.scannedFiles).toBe(1);
      expect(payload?.grounded?.files?.[0]?.path).toBe("memory/2025-01-01.md");
      expect(payload?.grounded?.files?.[0]?.renderedMarkdown).toContain("## What Happened");
      expect(payload?.grounded?.files?.[0]?.renderedMarkdown).toContain("## Reflections");
      expect(payload?.grounded?.files?.[0]?.renderedMarkdown).toContain(
        "## Possible Lasting Updates",
      );
      expect(payload?.grounded?.files?.[0]?.memoryImplications?.[0]?.text).toContain(
        'Always use "Happy Together" calendar for flights and reservations',
      );
      expect(close).toHaveBeenCalled();
    });
  });

  it("writes grounded rem backfill entries into DREAMS.md", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-01-01.md");
      await fs.writeFile(
        historyPath,
        [
          "## Preferences Learned",
          '- Always use "Happy Together" calendar for flights and reservations.',
          "- Calendar ID: udolnrooml2f2ha8jaio24v1r8@group.calendar.google.com",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      await runMemoryCli(["rem-backfill", "--path", historyPath]);

      const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
      expect(dreams).toContain("openclaw:dreaming:backfill-entry");
      expect(dreams).toContain(`source=${historyPath}`);
      expect(dreams).toContain("January 1, 2025");
      expect(dreams).toContain("What Happened");
      expect(dreams).toContain("Possible Lasting Updates");
      expect(dreams).toContain("Happy Together");
      expect(close).toHaveBeenCalled();
    });
  });

  it("treats a missing historical path as a controlled empty-source error", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const errors = spyRuntimeErrors(defaultRuntime);
      await runMemoryCli(["rem-backfill", "--path", path.join(workspaceDir, "missing-history")]);

      expect(
        errors.mock.calls.some((call) => String(call[0]).includes("found no YYYY-MM-DD.md files")),
      ).toBe(true);
      expect(close).toHaveBeenCalled();
    });
  });

  it("stages grounded durable candidates into the live short-term store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-01-01.md");
      await fs.writeFile(
        historyPath,
        [
          "## Preferences Learned",
          '- Always use "Happy Together" calendar for flights and reservations.',
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      await runMemoryCli(["rem-backfill", "--path", historyPath, "--stage-short-term"]);

      const entries = await readShortTermRecallEntries({ workspaceDir });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.snippet).toContain("Happy Together");
      expect(entries[0]?.groundedCount).toBe(3);
      expect(entries[0]?.queryHashes).toHaveLength(2);
      expect(entries[0]?.recallCount).toBe(0);
      expect(close).toHaveBeenCalled();
    });
  });

  it("rolls back grounded staged short-term entries without touching diary rollback", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-01-01.md");
      await fs.writeFile(
        historyPath,
        [
          "## Preferences Learned",
          '- Always use "Happy Together" calendar for flights and reservations.',
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      await runMemoryCli(["rem-backfill", "--path", historyPath, "--stage-short-term"]);
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });
      await runMemoryCli(["rem-backfill", "--rollback-short-term"]);

      const entries = await readShortTermRecallEntries({ workspaceDir });
      expect(entries).toHaveLength(0);
      expect(close).toHaveBeenCalled();
    });
  });

  it("prefers persistence-relevant evidence over narrated operational logs in grounded what happened", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-03-30.md");
      await fs.writeFile(
        historyPath,
        [
          "## OpenClaw / runtime / workflow preferences and corrections",
          "- Mariano explicitly said that when he tells Razor there has been an error, the default interpretation should be that he wants it fixed, not merely diagnosed or acknowledged.",
          "- Mariano clarified that the problem with cron output is overlapping, independently unreasonable crons converging into dumb sludge.",
          "",
          "## Versions / machine state and update work",
          "- MB Server repo updated but the active installed runtime is still old.",
          "- jpclawhq updated and running.",
          "",
          "## Other context and user preferences reinforced in this session",
          "- Mariano prefers short, punk, high-signal copy for social posts.",
          "- He explicitly wants the assistant to treat ADHD as a reason to reduce clutter and noise, not to produce more summaries.",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json", "--grounded", "--path", historyPath]);

      const payload = firstWrittenJsonArg<{
        grounded?: {
          files?: Array<{
            renderedMarkdown?: string;
            reflections?: Array<{ text: string }>;
          }>;
        } | null;
      }>(writeJson);
      const rendered = payload?.grounded?.files?.[0]?.renderedMarkdown ?? "";
      expect(rendered).toContain("prefers short, punk, high-signal copy");
      expect(rendered).not.toContain(
        "MB Server repo updated but the active installed runtime is still old",
      );
      expect(rendered).not.toContain("jpclawhq updated and running");
      expect(close).toHaveBeenCalled();
    });
  });

  it("suppresses monitoring-heavy operational days instead of promoting alert sludge", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-02-17.md");
      await fs.writeFile(
        historyPath,
        [
          "## Heartbeat checks",
          "- 04:17 (Europe/Madrid) heartbeat run.",
          "- Ariston check returned warning/error:",
          "  - Pressure LOW: 1.1 bar",
          "- Action: alert Mariano on this heartbeat.",
          "",
          "## 07:15 life-context sync (travel + now)",
          "- mariano@tpmcap.com calendar access failed (invalid_grant: token expired/revoked).",
          "- memory/email-tracker.json checkpoint at 2025-02-17T07:03:53+01:00.",
          "- memory/travel.md updated.",
          "",
          "## Heartbeat checks (07:18)",
          "- Ariston check again reports low pressure: 1.1 bar.",
          "- collect-temps.sh completed OK (exit 0).",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json", "--grounded", "--path", historyPath]);

      const payload = firstWrittenJsonArg<{
        grounded?: {
          files?: Array<{
            renderedMarkdown?: string;
            reflections?: Array<{ text: string }>;
          }>;
        } | null;
      }>(writeJson);
      const rendered = payload?.grounded?.files?.[0]?.renderedMarkdown ?? "";
      expect(rendered).toContain("No grounded facts were extracted.");
      expect(rendered).toContain("mostly as monitoring and operational state");
      expect(rendered).not.toContain("Pressure LOW");
      expect(rendered).not.toContain("invalid_grant");
      expect(close).toHaveBeenCalled();
    });
  });

  it("splits multi-fact person lines into atomic grounded candidates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-02-19.md");
      await fs.writeFile(
        historyPath,
        [
          "## People mentioned with context",
          "- Bunji — partner, Surrealist Ball Sat 28 Feb w/ Maga",
          "- Bex — girlfriend, date weekend Fri-Sun London, Chateau Denmark",
          "",
          "## Process improvements",
          "- Routed several inbound requests into different workflows.",
          "- Important context was written into notes and memory surfaces.",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json", "--grounded", "--path", historyPath]);

      const payload = firstWrittenJsonArg<{
        grounded?: {
          files?: Array<{
            renderedMarkdown?: string;
            reflections?: Array<{ text: string }>;
          }>;
        } | null;
      }>(writeJson);
      const file = payload?.grounded?.files?.[0];
      const rendered = file?.renderedMarkdown ?? "";
      expect(rendered).toContain(
        "People mentioned with context: Bunji — partner, Surrealist Ball Sat 28 Feb w/ Maga",
      );
      expect(rendered).toContain("Bex — girlfriend, date weekend Fri-Sun London, Chateau Denmark");
      expect(rendered).toContain("Bunji — partner");
      expect(rendered).toContain("Bex — girlfriend");
      expect(rendered).not.toContain("Bunji — Surrealist Ball Sat 28 Feb w/ Maga [");
      expect(rendered).not.toContain("Bex — date weekend Fri-Sun London, Chateau Denmark");
      expect(
        file?.reflections?.some((item) =>
          item.text.includes("More than one active relationship thread"),
        ),
      ).toBe(true);
      expect(
        file?.reflections?.some((item) =>
          item.text.includes("converting messy inbound information into routed workflows"),
        ),
      ).toBe(false);
      expect(close).toHaveBeenCalled();
    });
  });

  it("does not split hyphenated words into malformed grounded candidates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const historyDir = path.join(workspaceDir, "history");
      await fs.mkdir(historyDir, { recursive: true });
      const historyPath = path.join(historyDir, "2025-02-20.md");
      await fs.writeFile(
        historyPath,
        [
          "## Preferences Learned",
          "- Use long-term plans, avoid reactive task switching.",
          "- A self-aware workflow note should stay intact.",
        ].join("\n") + "\n",
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli(["rem-harness", "--json", "--grounded", "--path", historyPath]);

      const payload = firstWrittenJsonArg<{
        grounded?: {
          files?: Array<{
            renderedMarkdown?: string;
          }>;
        } | null;
      }>(writeJson);
      const rendered = payload?.grounded?.files?.[0]?.renderedMarkdown ?? "";
      expect(rendered).not.toContain("Use long- term plans");
      expect(rendered).not.toContain("A self- aware workflow note");
      expect(close).toHaveBeenCalled();
    });
  });

  it("rolls back grounded rem backfill entries from DREAMS.md", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      await fs.writeFile(
        dreamsPath,
        [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "---",
          "",
          "*April 5, 2026, 3:00 AM*",
          "",
          "Keep this normal dream.",
          "",
          "---",
          "",
          "*January 1, 2025*",
          "",
          "<!-- openclaw:dreaming:backfill-entry day=2025-01-01 source=memory/2025-01-01.md -->",
          "",
          "What Happened",
          "1. Remove this entry.",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
          "",
        ].join("\n"),
        "utf-8",
      );

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      await runMemoryCli(["rem-backfill", "--rollback"]);

      const dreams = await fs.readFile(dreamsPath, "utf-8");
      expect(dreams).toContain("Keep this normal dream.");
      expect(dreams).not.toContain("Remove this entry.");
      expect(close).toHaveBeenCalled();
    });
  });

  it("applies top promote candidates into MEMORY.md", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
        "line 8",
        "line 9",
        "Gateway host uses local mode and binds loopback port 18789",
        "Keep agent gateway local",
        "Expose healthcheck only on loopback",
        "Monitor restart policy",
        "Review proxy config",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "network setup",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 10,
            endLine: 14,
            score: 0.91,
            snippet: "Gateway host uses local mode and binds loopback port 18789",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli([
        "promote",
        "--apply",
        "--min-score",
        "0",
        "--min-recall-count",
        "0",
        "--min-unique-queries",
        "0",
      ]);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).toContain("Promoted From Short-Term Memory");
      expect(memoryText).toContain("openclaw-memory-promotion:");
      expect(memoryText).toContain("memory/2026-04-01.md:10-10");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Processed 1 candidate(s) for"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("appended=1 reconciledExisting=0"));
      expect(close).toHaveBeenCalled();
    });
  });

  it("prints conceptual promotion signals", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router vlan",
        nowMs: Date.parse("2026-04-01T00:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 4,
            endLine: 8,
            score: 0.9,
            snippet: "Configured router VLAN 10 and Glacier backup notes for QMD.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier backup",
        nowMs: Date.parse("2026-04-03T00:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 4,
            endLine: 8,
            score: 0.88,
            snippet: "Configured router VLAN 10 and Glacier backup notes for QMD.",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli([
        "promote",
        "--min-score",
        "0",
        "--min-recall-count",
        "0",
        "--min-unique-queries",
        "0",
      ]);

      expect(log).toHaveBeenCalledWith(expect.stringContaining("consolidate="));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("concepts="));
      expect(close).toHaveBeenCalled();
    });
  });

  async function waitFor<T>(task: () => Promise<T>, timeoutMs: number = 1500): Promise<T> {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Timed out waiting for async test condition");
  }

  it("records short-term recall entries from memory search hits", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const close = vi.fn(async () => {});
      const search = vi.fn(async () => [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.91,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ]);
      mockManager({
        search,
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      await runMemoryCli(["search", "glacier", "--json"]);

      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      const storeRaw = await waitFor(async () => await fs.readFile(storePath, "utf-8"));
      const store = JSON.parse(storeRaw) as {
        entries?: Record<string, { path: string; recallCount: number }>;
      };
      const entries = Object.values(store.entries ?? {});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        path: "memory/2026-04-03.md",
        recallCount: 1,
      });
      expect(close).toHaveBeenCalled();
    });
  });
});
