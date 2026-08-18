import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareEmbeddedAttemptBootstrap", () => {
  it("inherits bootstrap files from the canonical agent workspace for external sessions", async () => {
    const agentWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-"));
    const sessionWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-session-workspace-"),
    );
    tempDirs.push(agentWorkspace, sessionWorkspace);
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul");

    const result = await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        isCanonicalWorkspace: false,
        config: { agents: { defaults: { workspace: agentWorkspace } } },
      } as EmbeddedRunAttemptParams,
      bootstrapWorkspaceDir: agentWorkspace,
      effectiveWorkspace: sessionWorkspace,
      hasReadTool: true,
      isRawModelRun: false,
      markStage: () => undefined,
      resolvedWorkspace: sessionWorkspace,
      sessionAgentId: "main",
      sessionLabel: "agent:main:session-1",
    });

    expect(result.contextFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(agentWorkspace, "SOUL.md"),
          content: "Canonical agent soul",
        }),
      ]),
    );
  });
});
