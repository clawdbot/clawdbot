import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";

type WorkspaceAccess = "none" | "ro" | "rw";
type SandboxContext = NonNullable<
  Awaited<
    ReturnType<typeof import("../../../../src/agents/sandbox/context.js").resolveSandboxContext>
  >
>;

function createConfig(params: {
  access: WorkspaceAccess;
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
          workspaceAccess: params.access,
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
  };
}

async function run(
  sandbox: SandboxContext,
  script: string,
  args: string[] = [],
  allowFailure = false,
) {
  if (!sandbox.backend) {
    throw new Error("provisioned sandbox has no backend handle");
  }
  return await sandbox.backend.runShellCommand({ script, args, allowFailure });
}

async function expectOk(sandbox: SandboxContext, script: string, args: string[] = []) {
  const result = await run(sandbox, script, args);
  expect(result.code, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

test("Docker enforces none, read-only, and read-write workspace isolation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-isolation-"));
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "sandboxes");
  const unrelatedSentinel = path.join(root, "host-only-sentinel.txt");
  const image = process.env.OPENCLAW_SANDBOX_TEST_IMAGE ?? "openclaw-sandbox:bookworm-slim";
  const prefix = `oc-qa-${process.pid}-`;
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  const runtimes: string[] = [];

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(unrelatedSentinel, "host-only");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

  try {
    const [{ resolveSandboxContext }, { removeSandboxContainer }] = await Promise.all([
      import("../../../../src/agents/sandbox/context.js"),
      import("../../../../src/agents/sandbox/manage.js"),
    ]);

    for (const access of ["none", "ro", "rw"] as const) {
      const hostWorkspace = path.join(root, `agent-${access}-${randomUUID()}`);
      const hostSentinel = path.join(hostWorkspace, "host-sentinel.txt");
      await fs.mkdir(hostWorkspace, { recursive: true });
      if (access === "rw") {
        // Rootful Docker otherwise creates this nested bind target as root,
        // which leaves fixture teardown unable to remove its own temp tree.
        await fs.mkdir(path.join(hostWorkspace, ".openclaw", "sandbox-skills", "skills"), {
          recursive: true,
        });
      }
      await fs.writeFile(hostSentinel, `original-${access}`);

      let sandbox: SandboxContext | null = null;
      try {
        sandbox = await resolveSandboxContext({
          config: createConfig({ access, image, prefix, workspaceRoot }),
          agentId: `workspace-${access}`,
          sessionKey: `agent:workspace-${access}:qa-${randomUUID()}`,
          workspaceDir: hostWorkspace,
          requireCurrentConfig: true,
        });
        expect(sandbox).not.toBeNull();
        if (!sandbox) {
          throw new Error(`sandbox context missing for ${access}`);
        }
        runtimes.push(sandbox.runtimeId);
        expect(sandbox.workspaceAccess).toBe(access);
        await expectOk(sandbox, "grep -Eq ' /workspace ' /proc/self/mountinfo");
        await expectOk(sandbox, 'test ! -e "$1"', [unrelatedSentinel]);

        if (access === "none") {
          await expectOk(
            sandbox,
            'test ! -e /agent && test ! -e /workspace/host-sentinel.txt && test ! -e "$1"',
            [hostSentinel],
          );
          const mutation = await run(sandbox, "printf blocked > /workspace/blocked.txt", [], true);
          expect(mutation.code).not.toBe(0);
          await expect(fs.readFile(hostSentinel, "utf8")).resolves.toBe("original-none");
        } else if (access === "ro") {
          await expectOk(
            sandbox,
            'grep -Eq \' /agent \' /proc/self/mountinfo && test "$(cat /agent/host-sentinel.txt)" = "$1"',
            ["original-ro"],
          );
          const mutation = await run(
            sandbox,
            "printf blocked > /agent/host-sentinel.txt",
            [],
            true,
          );
          expect(mutation.code).not.toBe(0);
          await expect(fs.readFile(hostSentinel, "utf8")).resolves.toBe("original-ro");
        } else {
          await expectOk(
            sandbox,
            'printf persisted > /workspace/host-sentinel.txt && test "$(cat /workspace/host-sentinel.txt)" = persisted',
          );
          await expect(fs.readFile(hostSentinel, "utf8")).resolves.toBe("persisted");
        }
      } finally {
        if (sandbox) {
          await removeSandboxContainer(sandbox.runtimeId);
          runtimes.splice(runtimes.indexOf(sandbox.runtimeId), 1);
        }
      }
    }
  } finally {
    const { execDocker } = await import("../../../../src/agents/sandbox/docker.js");
    for (const runtimeId of runtimes) {
      await execDocker(["rm", "-f", runtimeId], { allowFailure: true });
    }
    env.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
