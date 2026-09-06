import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareEmbeddedAttemptBootstrap", () => {
  async function prepare(params: { agentWorkspace: string; sessionWorkspace: string }) {
    return await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        bootstrapWorkspaceDir: params.agentWorkspace,
        isCanonicalWorkspace: params.agentWorkspace === params.sessionWorkspace,
        config: { agents: { defaults: { workspace: params.agentWorkspace } } },
      } as EmbeddedRunAttemptParams,
      setup: createAttemptSetupFixture({
        effectiveWorkspace: params.sessionWorkspace,
        resolvedWorkspace: params.sessionWorkspace,
      }),
      hasReadTool: true,
      isRawModelRun: false,
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
      setup: createAttemptSetupFixture({
        effectiveWorkspace: workspace,
        resolvedWorkspace: workspace,
      }),
      hasReadTool: true,
      isRawModelRun: false,
    });

    expect(explicit).toEqual(omitted);
  });
});
