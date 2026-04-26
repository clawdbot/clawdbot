import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  loadEmbeddedToolRuntimeFromPackage,
  resolveLobsterCwd,
} from "./lobster-runner.js";

describe("resolveLobsterCwd", () => {
  it("defaults to the current working directory", () => {
    expect(resolveLobsterCwd(undefined)).toBe(process.cwd());
  });

  it("keeps relative paths inside the repo root", () => {
    expect(resolveLobsterCwd("extensions/lobster")).toBe(
      path.resolve(process.cwd(), "extensions/lobster"),
    );
  });
});

describe("createEmbeddedLobsterRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs inline pipelines through the embedded runtime", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledTimes(1);
    expect(runtime.runToolRequest).toHaveBeenCalledWith({
      pipeline: "exec --json=true echo hi",
      ctx: expect.objectContaining({
        cwd: process.cwd(),
        mode: "tool",
        signal: expect.any(AbortSignal),
      }),
    });
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it("detects workflow files and parses argsJson", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [],
          requiresApproval: null,
        }),
        resumeToolRequest: vi.fn(),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await runner.run({
        action: "run",
        pipeline: "workflow.lobster",
        argsJson: '{"limit":3}',
        cwd: tempDir,
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledWith({
        filePath: workflowPath,
        args: { limit: 3 },
        ctx: expect.objectContaining({
          cwd: tempDir,
          mode: "tool",
        }),
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          pipeline: "workflow.lobster",
          argsJson: "{bad",
          cwd: tempDir,
          timeoutMs: 2000,
          maxStdoutBytes: 4096,
        }),
      ).rejects.toThrow("run --args-json must be valid JSON");
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when the embedded runtime returns an error envelope", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: false,
        protocolVersion: 1,
        error: {
          type: "runtime_error",
          message: "boom",
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow("boom");
  });

  it("fails closed when the embedded runtime requests unsupported input", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: {
          prompt: "Need more data",
          schema: { type: "string" },
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow("Lobster input requests are not supported by the OpenClaw Lobster tool yet");
  });

  it("routes resume through the embedded runtime", async () => {
    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "resume",
      token: "resume-token",
      approve: false,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledWith({
      token: "resume-token",
      approved: false,
      ctx: expect.objectContaining({
        cwd: process.cwd(),
        mode: "tool",
        signal: expect.any(AbortSignal),
      }),
    });
    expect(envelope).toEqual({
      ok: true,
      status: "cancelled",
      output: [],
      requiresApproval: null,
    });
  });

  it("forwards approvalId through resume when token is absent", async () => {
    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await runner.run({
      action: "resume",
      approvalId: "dbc98d05",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx: expect.objectContaining({ mode: "tool" }),
    });
  });

  it("passes approvalId through the normalized needs_approval envelope", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "ok?",
          items: [],
          resumeToken: "eyJ...",
          approvalId: "dbc98d05",
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(envelope).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "ok?",
        items: [],
        resumeToken: "eyJ...",
        approvalId: "dbc98d05",
      },
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      }),
    };
    const loadRuntime = vi.fn().mockResolvedValue(runtime);

    const runner = createEmbeddedLobsterRunner({ loadRuntime });

    await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });
    await runner.run({
      action: "resume",
      token: "resume-token",
      approve: false,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("falls back to the installed package core file when the core export is unavailable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-package-"));
    const packageRoot = path.join(tempDir, "node_modules", "@clawdbot", "lobster");
    const packageEntryPath = path.join(packageRoot, "dist", "src", "sdk", "index.js");
    const packageCorePath = path.join(packageRoot, "dist", "src", "core", "index.js");

    try {
      await fs.mkdir(path.dirname(packageEntryPath), { recursive: true });
      await fs.mkdir(path.dirname(packageCorePath), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@clawdbot/lobster",
          type: "module",
          main: "./dist/src/sdk/index.js",
        }),
        "utf8",
      );
      await fs.writeFile(packageEntryPath, "export {};\n", "utf8");
      await fs.writeFile(
        packageCorePath,
        [
          "export async function runToolRequest() {",
          "  return { ok: true, status: 'ok', output: [{ source: 'fallback' }], requiresApproval: null };",
          "}",
          "export async function resumeToolRequest() {",
          "  return { ok: true, status: 'cancelled', output: [], requiresApproval: null };",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const runtime = await loadEmbeddedToolRuntimeFromPackage({
        importModule: async (specifier) => {
          if (specifier === "@clawdbot/lobster/core") {
            throw new Error("package export missing");
          }
          return (await import(`${specifier}?t=${Date.now()}`)) as object;
        },
        resolvePackageEntry: () => packageEntryPath,
      });

      await expect(runtime.runToolRequest({ pipeline: "commands.list" })).resolves.toEqual({
        ok: true,
        status: "ok",
        output: [{ source: "fallback" }],
        requiresApproval: null,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires a pipeline for run", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "run",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/pipeline required/);
  });

  it("requires token and approve for resume", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "resume",
        approve: true,
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/token or approvalId required/);

    await expect(
      runner.run({
        action: "resume",
        token: "resume-token",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/approve required/);
  });

  it("aborts long-running embedded work", async () => {
    const runtime = {
      runToolRequest: vi.fn(
        async ({ ctx }: { ctx?: { signal?: AbortSignal } }) =>
          await new Promise((resolve, reject) => {
            ctx?.signal?.addEventListener("abort", () => {
              reject(ctx.signal?.reason ?? new Error("aborted"));
            });
            setTimeout(
              () => resolve({ ok: true, status: "ok", output: [], requiresApproval: null }),
              500,
            );
          }),
      ),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 200,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/timed out|aborted/);
  });
});
