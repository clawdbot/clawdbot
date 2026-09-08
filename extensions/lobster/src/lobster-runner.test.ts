import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Lobster tests cover lobster runner plugin behavior.
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedLobsterRunner, resolveLobsterCwd } from "./lobster-runner.js";

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function expectToolContext(value: unknown, expected: { cwd?: string; mode: "tool" }) {
  const ctx = requireRecord(value, "tool context");
  if (expected.cwd !== undefined) {
    expect(ctx.cwd).toBe(expected.cwd);
  }
  expect(ctx.mode).toBe(expected.mode);
  expect(ctx.signal).toBeInstanceOf(AbortSignal);
}

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
    const request = requireRecord(
      requireFirstCallParam(runtime.runToolRequest.mock.calls, "run tool request"),
      "run tool request",
    );
    expect(request.pipeline).toBe("exec --json=true echo hi");
    expectToolContext(request.ctx, { cwd: process.cwd(), mode: "tool" });
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it.each([
    "exec --json=true cat data.json",
    "exec --json=true cat config.yaml",
    "exec --json=true cat flow.lobster",
    "exec --json=true cat /tmp/missing.json",
    "http.fetch https://example.test/workflows/flow.lobster",
    "exec --json=true echo nested/path",
  ])("keeps inline pipeline with file-like args as a pipeline: %s", async (pipeline) => {
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
      pipeline,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.runToolRequest.mock.calls, "inline run tool request"),
      "inline run tool request",
    );
    expect(request.pipeline).toBe(pipeline);
    expect(request.filePath).toBeUndefined();
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

      expect(runtime.runToolRequest).toHaveBeenCalledOnce();
      const request = requireRecord(
        requireFirstCallParam(runtime.runToolRequest.mock.calls, "workflow run tool request"),
        "workflow run tool request",
      );
      expect(request.filePath).toBe(workflowPath);
      expect(request.args).toEqual({ limit: 3 });
      expectToolContext(request.ctx, { cwd: tempDir, mode: "tool" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects existing workflow file paths that contain spaces", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "daily inbox.lobster");
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
        pipeline: "daily inbox.lobster",
        cwd: tempDir,
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledOnce();
      const request = requireRecord(
        requireFirstCallParam(runtime.runToolRequest.mock.calls, "workflow file with spaces"),
        "workflow file with spaces",
      );
      expect(request.filePath).toBe(workflowPath);
      expect(request.pipeline).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing.lobster", "missing.lobster"],
    ["nested/missing.yaml", path.join("nested", "missing.yaml")],
  ])("surfaces missing workflow path errors for %s", async (pipeline, expectedRelativePath) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));

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
          pipeline,
          cwd: tempDir,
          timeoutMs: 2000,
          maxStdoutBytes: 4096,
        }),
      ).rejects.toMatchObject({
        code: "ENOENT",
        path: path.join(tempDir, expectedRelativePath),
      });
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
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

  it.each(["complete", "token", "prompt", "schema"])(
    "validates the dependency input checkpoint (%s)",
    async (checkpoint) => {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          protocolVersion: 1,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            prompt: "Need more data",
            responseSchema: { type: "string" },
            resumeToken: "input-checkpoint",
            defaults: "draft",
            subject: { title: "Review" },
            ...(checkpoint === "token" ? { resumeToken: undefined } : {}),
            ...(checkpoint === "prompt" ? { prompt: undefined } : {}),
            ...(checkpoint === "schema" ? { responseSchema: undefined } : {}),
          },
        }),
        resumeToolRequest: vi.fn(),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      const result = runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });
      if (checkpoint !== "complete") {
        await expect(result).rejects.toThrow("Lobster returned an incomplete input checkpoint");
        return;
      }
      await expect(result).resolves.toMatchObject({
        ok: true,
        status: "needs_input",
        requiresInput: {
          type: "input_request",
          prompt: "Need more data",
          responseSchema: { type: "string" },
          resumeToken: "input-checkpoint",
          defaults: "draft",
          subject: { title: "Review" },
        },
      });
    },
  );

  it.each([
    { label: "approval", decision: { approve: false }, expected: { approved: false } },
    { label: "false input", decision: { response: false }, expected: { response: false } },
    { label: "null input", decision: { response: null }, expected: { response: null } },
    { label: "cancellation", decision: { cancel: true }, expected: { cancel: true } },
  ])("routes $label resume through the embedded runtime", async ({ decision, expected }) => {
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
      ...decision,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "resume tool request"),
      "resume tool request",
    );
    expect(request).toEqual({ token: "resume-token", ...expected, ctx: expect.any(Object) });
    expectToolContext(request.ctx, { cwd: process.cwd(), mode: "tool" });
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

    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "approval resume tool request"),
      "approval resume tool request",
    );
    expect(request.approvalId).toBe("dbc98d05");
    expect(request.approved).toBe(true);
    expectToolContext(request.ctx, { mode: "tool" });
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

  it("loads the published package core runtime", async () => {
    await expect(
      createEmbeddedLobsterRunner().run({
        action: "run",
        pipeline: "commands.list",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 512_000,
      }),
    ).resolves.toMatchObject({ ok: true, status: "ok" });
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

  it.each([
    { label: "credential", decision: { approve: true }, error: "token or approvalId required" },
    { label: "decision", decision: { token: "resume-token" }, error: "Exactly one" },
    {
      label: "approval and input",
      decision: { token: "resume-token", approve: false, response: null },
      error: "Exactly one",
    },
    {
      label: "input and cancel",
      decision: { token: "resume-token", response: false, cancel: true },
      error: "Exactly one",
    },
    {
      label: "approval and cancel",
      decision: { token: "resume-token", approve: true, cancel: true },
      error: "Exactly one",
    },
  ])("rejects invalid resume $label before dispatch", async ({ decision, error }) => {
    const runtime = { runToolRequest: vi.fn(), resumeToolRequest: vi.fn() };
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "resume",
        ...decision,
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(error);
    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("rechecks the managed claim after runtime loading before dispatch", async () => {
    const runtime = { runToolRequest: vi.fn(), resumeToolRequest: vi.fn() };
    const loaded = createDeferred<typeof runtime>();
    const runner = createEmbeddedLobsterRunner({ loadRuntime: () => loaded.promise });
    let claimActive = true;
    const beforeExecute = vi.fn(() => {
      if (!claimActive) {
        throw new Error("Flow claim was cancelled");
      }
    });
    const result = runner.run({
      action: "resume",
      token: "resume-token",
      response: null,
      beforeExecute,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });
    expect(beforeExecute).not.toHaveBeenCalled();
    claimActive = false;
    const rejected = expect(result).rejects.toThrow("Flow claim was cancelled");
    loaded.resolve(runtime);
    await rejected;
    expect(beforeExecute).toHaveBeenCalledOnce();
    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("aborts long-running embedded work", async () => {
    const runtime = {
      runToolRequest: vi.fn(
        async ({ ctx }: { ctx?: { signal?: AbortSignal } }) =>
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => resolve({ ok: true, status: "ok", output: [], requiresApproval: null }),
              500,
            );
            ctx?.signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(
                toLintErrorObject(
                  ctx.signal?.reason ?? new Error("aborted"),
                  "Non-Error rejection",
                ),
              );
            });
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
