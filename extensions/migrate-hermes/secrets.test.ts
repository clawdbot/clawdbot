import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_REASON_AUTH_PROFILE_EXISTS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

describe("Hermes migration secret items", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("uses configured agentDir for secret planning and imports without runtime helpers", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const customAgentDir = path.join(root, "custom-agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [
          {
            id: "custom",
            default: true,
            agentDir: customAgentDir,
          },
        ],
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
      }),
    );

    expect(plan.metadata?.agentDir).toBe(customAgentDir);
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "secret:openai",
          target: `${customAgentDir}/auth-profiles.json#openai:hermes-import`,
          status: "planned",
        }),
      ]),
    );

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
        overwrite: true,
        reportDir: path.join(root, "report"),
      }),
    );

    expect(result.summary.errors).toBe(0);
    const authStore = JSON.parse(
      await fs.readFile(path.join(customAgentDir, "auth-profiles.json"), "utf8"),
    ) as { profiles?: Record<string, { key?: string; provider?: string }> };
    expect(authStore.profiles?.["openai:hermes-import"]).toMatchObject({
      provider: "openai",
      key: "sk-hermes",
    });
    await expect(
      fs.access(path.join(stateDir, "agents", "custom", "agent", "auth-profiles.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps secret conflict checks read-only during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", provider: "openai", key: "legacy-main-key" },
      }),
    );

    const provider = buildHermesMigrationProvider();
    await provider.plan(makeContext({ source, stateDir, workspaceDir, includeSecrets: true }));

    await expect(fs.access(path.join(agentDir, "auth.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports late-created auth profiles as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      includeSecrets: true,
      reportDir,
    });
    const plan = await provider.plan(ctx);
    await writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai:hermes-import": {
              type: "api_key",
              provider: "openai",
              key: "sk-late",
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "secret:openai",
          status: "conflict",
          reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
        }),
      ]),
    );
    expect(result.summary.conflicts).toBe(1);
    const authStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as { profiles?: Record<string, { key?: string }> };
    expect(authStore.profiles?.["openai:hermes-import"]?.key).toBe("sk-late");
  });
});
