import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareEmbeddedAttemptBootstrap", () => {
  async function prepare(params: { agentWorkspace: string; sessionWorkspace: string }) {
    return await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        isCanonicalWorkspace: params.agentWorkspace === params.sessionWorkspace,
        config: { agents: { defaults: { workspace: params.agentWorkspace } } },
      } as EmbeddedRunAttemptParams,
      bootstrapWorkspaceDir: params.agentWorkspace,
      effectiveWorkspace: params.sessionWorkspace,
      hasReadTool: true,
      isRawModelRun: false,
      markStage: () => undefined,
      resolvedWorkspace: params.sessionWorkspace,
      sessionAgentId: "main",
      sessionLabel: "agent:main:session-1",
    });
  }

  it("layers execution project instructions after agent bootstrap files", async () => {
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const sessionWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-workspace-")),
    );
    tempDirs.push(agentWorkspace, sessionWorkspace);
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(sessionWorkspace, "AGENTS.md"), "Execution project context");
    await fs.writeFile(path.join(sessionWorkspace, "SOUL.md"), "Execution soul must stay private");

    const result = await prepare({ agentWorkspace, sessionWorkspace });
    const executionAgentsIndex = result.contextFiles.findIndex(
      (file) => file.path === path.join(sessionWorkspace, "AGENTS.md"),
    );
    const lastAgentFileIndex = result.contextFiles.findLastIndex((file) =>
      file.path.startsWith(`${agentWorkspace}${path.sep}`),
    );

    expect(executionAgentsIndex).toBeGreaterThan(lastAgentFileIndex);
    expect(result.contextFiles[executionAgentsIndex]).toEqual(
      expect.objectContaining({
        path: path.join(sessionWorkspace, "AGENTS.md"),
        content: "Execution project context",
      }),
    );
    expect(result.contextFiles).toContainEqual(
      expect.objectContaining({
        path: path.join(agentWorkspace, "SOUL.md"),
        content: "Canonical agent soul",
      }),
    );
    expect(result.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: path.join(sessionWorkspace, "SOUL.md") }),
    );
  });

  it("keeps same-workspace bootstrap output byte-identical", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-same-workspace-")),
    );
    tempDirs.push(workspace);
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Same workspace instructions");
    await fs.writeFile(path.join(workspace, "SOUL.md"), "Same workspace soul");

    const explicit = await prepare({ agentWorkspace: workspace, sessionWorkspace: workspace });
    const omitted = await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        isCanonicalWorkspace: true,
        config: { agents: { defaults: { workspace } } },
      } as EmbeddedRunAttemptParams,
      effectiveWorkspace: workspace,
      hasReadTool: true,
      isRawModelRun: false,
      markStage: () => undefined,
      resolvedWorkspace: workspace,
      sessionAgentId: "main",
      sessionLabel: "agent:main:session-1",
    });

    expect(explicit).toEqual(omitted);
  });

  it("warns with the substage breakdown when bootstrap-context exceeds the slow threshold", async () => {
    // A bootstrap-context run over 2000ms emits its per-substage breakdown at
    // warn level so a stalled default run is visible without enabling debug
    // logging. A monotonic performance.now stub forces the total past the
    // threshold; each call returns a larger value, so the final elapsed delta is
    // always well over 2000ms regardless of how many substages ran.
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slow-bootstrap-")),
    );
    tempDirs.push(workspace);
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Slow workspace instructions");

    let nowCalls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls * 5_000;
    });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await prepareEmbeddedAttemptBootstrap({
      attempt: {
        runId: "run-slow",
        sessionId: "session-slow",
        sessionKey: "agent:main:session-slow",
        trigger: "user",
        isCanonicalWorkspace: true,
        config: { agents: { defaults: { workspace } } },
      } as EmbeddedRunAttemptParams,
      effectiveWorkspace: workspace,
      hasReadTool: true,
      isRawModelRun: false,
      markStage: () => undefined,
      resolvedWorkspace: workspace,
      sessionAgentId: "main",
      sessionLabel: "agent:main:session-slow",
    });

    const breakdownWarn = warnSpy.mock.calls
      .map((call) => call[0])
      .find(
        (message) =>
          typeof message === "string" && message.includes("bootstrap-context substages:"),
      );
    expect(breakdownWarn).toBeDefined();
    expect(breakdownWarn).toContain("runId=run-slow");
    expect(breakdownWarn).toContain("sessionId=session-slow");
    expect(breakdownWarn).toMatch(/totalMs=\d/);
  });
});
