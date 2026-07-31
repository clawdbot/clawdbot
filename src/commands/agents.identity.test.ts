// Agent identity tests cover identity file creation, persistence, and command integration.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const TEST_MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

const configMocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn().mockResolvedValue(undefined);
  return {
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(async (params: { nextConfig: unknown }) => {
      await writeConfigFile(params.nextConfig);
    }),
  };
});

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  writeConfigFile: configMocks.writeConfigFile,
  replaceConfigFile: configMocks.replaceConfigFile,
}));

import { agentsSetIdentityCommand } from "./agents.commands.identity.js";

const runtime = createTestRuntime();
type ConfigWritePayload = {
  agents?: { entries?: Record<string, { identity?: Record<string, string> }> };
};

async function createIdentityWorkspace(subdir = "work") {
  const root = await makeTempWorkspace("openclaw-identity-");
  const workspace = path.join(root, subdir);
  await fs.mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function writeIdentityFile(workspace: string, lines: string[]) {
  const identityPath = path.join(workspace, "IDENTITY.md");
  await fs.writeFile(identityPath, `${lines.join("\n")}\n`, "utf-8");
  return identityPath;
}

function getWrittenMainIdentity() {
  const [written] = configMocks.writeConfigFile.mock.calls[0] ?? [];
  if (!written) {
    throw new Error("expected written agent config");
  }
  const payload = written as ConfigWritePayload;
  return payload.agents?.entries?.main?.identity;
}

async function runIdentityCommandFromWorkspace(workspace: string, fromIdentity = true) {
  configMocks.readConfigFileSnapshot.mockResolvedValue({
    ...baseConfigSnapshot,
    config: { agents: { entries: { main: { workspace } } } },
  });
  await agentsSetIdentityCommand({ workspace, fromIdentity }, runtime);
}

describe("agents set-identity command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    configMocks.replaceConfigFile.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("sets identity from workspace IDENTITY.md", async () => {
    const { root, workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, [
      "- Name: OpenClaw",
      "- Creature: helpful sloth",
      "- Emoji: :)",
      "- Avatar: avatars/openclaw.png",
      "",
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          entries: {
            main: { workspace },
            ops: { workspace: path.join(root, "ops") },
          },
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(getWrittenMainIdentity()).toEqual({
      name: "OpenClaw",
      theme: "helpful sloth",
      emoji: ":)",
      avatar: "avatars/openclaw.png",
    });
  });

  it("resolves --from-identity against the selected agent workspace", async () => {
    const { root, workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, ["- Name: Workspace Agent"]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: { workspace } } } },
    });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);

    try {
      await agentsSetIdentityCommand({ agent: "main", fromIdentity: true }, runtime);
    } finally {
      cwdSpy.mockRestore();
    }

    expect(getWrittenMainIdentity()).toEqual({ name: "Workspace Agent" });
  });

  it("errors when multiple agents match the same workspace", async () => {
    const { workspace } = await createIdentityWorkspace("shared");
    await writeIdentityFile(workspace, ["- Name: Echo"]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          entries: { main: { workspace }, ops: { workspace } },
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      `Multiple agents match ${workspace}: main, ops. Pass --agent to choose one.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("overrides identity file values with explicit flags", async () => {
    const { workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, [
      "- Name: OpenClaw",
      "- Theme: space lobster",
      "- Emoji: :)",
      "- Avatar: avatars/openclaw.png",
      "",
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: { workspace } } } },
    });

    await agentsSetIdentityCommand(
      {
        workspace,
        fromIdentity: true,
        name: "Nova",
        emoji: "🦞",
        avatar: "https://example.com/override.png",
      },
      runtime,
    );

    expect(getWrittenMainIdentity()).toEqual({
      name: "Nova",
      theme: "space lobster",
      emoji: "🦞",
      avatar: "https://example.com/override.png",
    });
  });

  it("reads identity from an explicit IDENTITY.md path", async () => {
    const { workspace } = await createIdentityWorkspace();
    const identityPath = await writeIdentityFile(workspace, [
      "- **Name:** C-3PO",
      "- **Creature:** Flustered Protocol Droid",
      "- **Emoji:** 🤖",
      "- **Avatar:** avatars/c3po.png",
      "",
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: {} } } },
    });

    await agentsSetIdentityCommand({ agent: "main", identityFile: identityPath }, runtime);

    expect(getWrittenMainIdentity()).toEqual({
      name: "C-3PO",
      theme: "Flustered Protocol Droid",
      emoji: "🤖",
      avatar: "avatars/c3po.png",
    });
  });

  it("accepts avatar-only identity from IDENTITY.md", async () => {
    const { workspace } = await createIdentityWorkspace();
    await writeIdentityFile(workspace, ["- Avatar: avatars/only.png"]);

    await runIdentityCommandFromWorkspace(workspace);

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "avatars/only.png",
    });
  });

  it("accepts avatar-only updates via flags", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: {} } } },
    });

    await agentsSetIdentityCommand(
      { agent: "main", avatar: "https://example.com/avatar.png" },
      runtime,
    );

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "https://example.com/avatar.png",
    });
  });

  it("errors without changing config when --agent names an unknown agent", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: {} } } },
    });

    await agentsSetIdentityCommand({ agent: "ghostzzz", name: "Ghost" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      'Agent "ghostzzz" not found. Create it with `openclaw agents add`.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it.each(["main", "openclaw", "crestodian"])(
    "does not create absent reserved agent %s",
    async (agentId) => {
      configMocks.readConfigFileSnapshot.mockResolvedValue({
        ...baseConfigSnapshot,
        config: { agents: { entries: { ops: {} } } },
      });

      await agentsSetIdentityCommand({ agent: agentId, name: "Hijack" }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        `Agent "${agentId}" not found. Create it with \`openclaw agents add\`.`,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("still updates a real existing agent", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          entries: { ops: { identity: { emoji: "🛠️" } } },
        },
      },
    });

    await agentsSetIdentityCommand({ agent: "ops", name: "Operator" }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const [written] = configMocks.writeConfigFile.mock.calls[0] ?? [];
    expect(written).toMatchObject({
      agents: {
        entries: { ops: { identity: { name: "Operator", emoji: "🛠️" } } },
      },
    });
  });

  it("still resolves and updates the implicit default agent by workspace", async () => {
    const { workspace } = await createIdentityWorkspace("implicit-main");
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          defaults: { workspace },
          entries: {},
        },
      },
    });

    await agentsSetIdentityCommand({ workspace, name: "Default Agent" }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const [written] = configMocks.writeConfigFile.mock.calls[0] ?? [];
    expect(written).toMatchObject({
      agents: {
        entries: { main: { identity: { name: "Default Agent" } } },
      },
    });
  });

  it("errors when an explicit identity file exceeds the size cap", async () => {
    const { workspace } = await createIdentityWorkspace();
    const identityPath = await writeIdentityFile(workspace, [
      "- Name: Oversized",
      "x".repeat(TEST_MAX_IDENTITY_FILE_BYTES + 1),
    ]);

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: {} } } },
    });

    await agentsSetIdentityCommand({ agent: "main", identityFile: identityPath }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      `Identity file ${identityPath} exceeds the maximum size of ${TEST_MAX_IDENTITY_FILE_BYTES} bytes`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("errors when identity data is missing", async () => {
    const { workspace } = await createIdentityWorkspace();

    await runIdentityCommandFromWorkspace(workspace);

    expect(runtime.error).toHaveBeenCalledWith(
      `No identity data found in ${path.join(workspace, "IDENTITY.md")}.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
