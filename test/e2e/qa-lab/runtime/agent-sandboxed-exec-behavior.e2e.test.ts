import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createOpenClawCodingTools } from "../../../../src/agents/agent-tools.js";
import { resolveAttemptWorkspaceSandbox } from "../../../../src/agents/embedded-agent-runner/run/attempt-setup.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";

function createConfig(params: {
  image: string;
  prefix: string;
  workspaceRoot: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "session",
          workspaceAccess: "rw",
          workspaceRoot: params.workspaceRoot,
          docker: {
            image: params.image,
            containerPrefix: params.prefix,
          },
          browser: { enabled: false },
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
    tools: {
      exec: {
        host: "auto",
        security: "full",
        ask: "off",
      },
    },
  };
}

test("host:auto executes inside the resolved Docker sandbox", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandboxed-exec-"));
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const outsideDir = path.join(root, "host-only");
  const outsideScript = path.join(outsideDir, "must-not-run.sh");
  const outsideMarker = path.join(outsideDir, "executed.txt");
  const workspaceMarker = path.join(workspaceDir, "container-marker.txt");
  const image = process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:bookworm-slim";
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  let runtimeId: string | undefined;

  await fs.mkdir(path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills"), {
    recursive: true,
  });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(
    outsideScript,
    `#!/bin/sh\nprintf executed > ${JSON.stringify(outsideMarker)}\n`,
    { mode: 0o755 },
  );
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

  try {
    const sessionId = randomUUID();
    const sessionKey = `agent:sandboxed-exec:qa:${sessionId}`;
    const config = createConfig({
      image,
      prefix: `oc-qa-exec-${process.pid}-`,
      workspaceRoot: path.join(root, "sandboxes"),
    });
    const workspace = await resolveAttemptWorkspaceSandbox({
      agentId: "sandboxed-exec",
      config,
      sessionId,
      sessionKey,
      workspaceDir,
    });
    expect(workspace.sandbox).not.toBeNull();
    if (!workspace.sandbox) {
      throw new Error("expected a provisioned Docker sandbox");
    }
    runtimeId = workspace.sandbox.runtimeId;

    const exec = createOpenClawCodingTools({
      agentId: workspace.sessionAgentId,
      config,
      cwd: workspace.effectiveCwd,
      exec: { host: "auto", security: "full", ask: "off" },
      sandbox: workspace.sandbox,
      sessionId,
      sessionKey,
      workspaceDir: workspace.effectiveWorkspace,
    }).find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    if (!exec) {
      throw new Error("exec tool missing from sandboxed agent surface");
    }

    const result = await exec.execute("sandboxed-exec", {
      command: [
        'if [ -x "$OUTSIDE_SCRIPT" ]; then "$OUTSIDE_SCRIPT"; exit 41; fi',
        'test ! -e "$OUTSIDE_SCRIPT"',
        "test -f /.dockerenv",
        "grep -Eq ' /workspace ' /proc/self/mountinfo",
        "printf 'sandbox-ok\\n' > /workspace/container-marker.txt",
        "printf 'sandbox-ok\\n'",
      ].join(" && "),
      env: { OUTSIDE_SCRIPT: outsideScript },
      host: "auto",
      yieldMs: 120_000,
    });

    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect((result.details as { aggregated?: string }).aggregated).toContain("sandbox-ok");
    await expect(fs.readFile(workspaceMarker, "utf8")).resolves.toBe("sandbox-ok\n");
    await expect(fs.access(outsideMarker)).rejects.toThrow();
    await expect(fs.readFile(outsideScript, "utf8")).resolves.toContain("printf executed");
  } finally {
    if (runtimeId) {
      const [{ removeSandboxContainer }, { execDocker }] = await Promise.all([
        import("../../../../src/agents/sandbox/manage.js"),
        import("../../../../src/agents/sandbox/docker.js"),
      ]);
      await removeSandboxContainer(runtimeId);
      await execDocker(["rm", "-f", runtimeId], { allowFailure: true });
    }
    env.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
