// Agent identity tests cover identity file creation, persistence, and command integration.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createCapturingTestRuntime,
  createTestConfigSnapshot,
  createTestRuntime,
} from "./test-runtime-config-helpers.js";

const TEST_MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

const configMocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn().mockResolvedValue(undefined);
  return {
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(async (params: { sourceConfig: unknown }) => {
      await writeConfigFile(params.sourceConfig);
      return { nextConfig: params.sourceConfig };
    }),
  };
});

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => {
    const snapshot = await configMocks.readConfigFileSnapshot();
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
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
  configMocks.readConfigFileSnapshot.mockResolvedValue(
    createTestConfigSnapshot({ agents: { entries: { main: { workspace } } } }),
  );
  await agentsSetIdentityCommand({ workspace, fromIdentity }, runtime);
}

async function expectIdentityCommandFailure(
  options: Parameters<typeof agentsSetIdentityCommand>[0],
  message: string,
) {
  await expect(agentsSetIdentityCommand(options, runtime)).rejects.toMatchObject({
    name: "ExpectedCliError",
    message,
    humanOutput: message,
    machineOutput: message,
  });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
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

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: {
          entries: {
            main: { workspace },
            ops: { workspace: path.join(root, "ops") },
          },
        },
      }),
    );

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

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: { workspace } } } }),
    );
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
    const identityPath = await writeIdentityFile(workspace, ["- Name: Echo"]);
    const originalIdentity = await fs.readFile(identityPath, "utf8");

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: {
          entries: { main: { workspace }, ops: { workspace } },
        },
      }),
    );

    await expectIdentityCommandFailure(
      { workspace },
      `Multiple agents match ${workspace}: main, ops. Pass --agent to choose one.`,
    );
    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
  });

  it("rejects an unmatched workspace before reading or changing its identity file", async () => {
    const { workspace } = await createIdentityWorkspace("unmatched");
    const identityPath = await writeIdentityFile(workspace, ["- Name: Untouched"]);
    const originalIdentity = await fs.readFile(identityPath, "utf8");
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: {} } } }),
    );

    await expectIdentityCommandFailure(
      { workspace, name: "Override", json: true },
      `No agent workspace matches ${workspace}. Pass --agent to target a specific agent.`,
    );

    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
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

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: { workspace } } } }),
    );

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

  it("sanitizes identity echoes while preserving stored and JSON values", async () => {
    const name = "Operator\u001B]0;identity-injection\u0007🦞\r\nforged-row\tbadge";
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: {} } } }),
    );

    await agentsSetIdentityCommand({ agent: "main", name }, runtime);

    const textOutput = runtime.log.mock.calls.flat().join("\n");
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Operator🦞\\r\\nforged-row\\tbadge");
    expect(getWrittenMainIdentity()).toEqual({ name });

    const jsonRuntime = createCapturingTestRuntime();
    await agentsSetIdentityCommand({ agent: "main", name, json: true }, jsonRuntime.runtime);
    const payload = JSON.parse(jsonRuntime.logs.at(-1) ?? "{}") as {
      agentId: string;
      identity: { name: string };
      workspace: string | null;
      identityFile: string | null;
      storedWorkspace: string;
    };
    expect(payload).toMatchObject({
      agentId: "main",
      identity: { name },
      workspace: null,
      identityFile: null,
    });
    expect(payload.storedWorkspace).toEqual(expect.any(String));
    expect(payload.storedWorkspace).not.toBe("");
  });

  it("reads and reports an explicit IDENTITY.md path", async () => {
    const { root, workspace } = await createIdentityWorkspace();
    const storedWorkspace = path.join(root, "stored");
    await fs.mkdir(storedWorkspace, { recursive: true });
    const identityPath = await writeIdentityFile(workspace, [
      "- **Name:** C-3PO",
      "- **Creature:** Flustered Protocol Droid",
      "- **Emoji:** 🤖",
      "- **Avatar:** avatars/c3po.png",
      "",
    ]);
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: { workspace: storedWorkspace } } } }),
    );

    const jsonRuntime = createCapturingTestRuntime();
    await agentsSetIdentityCommand(
      { agent: "main", identityFile: identityPath, json: true },
      jsonRuntime.runtime,
    );

    const [written] = configMocks.writeConfigFile.mock.calls[0] ?? [];
    expect(written).toMatchObject({
      agents: {
        entries: {
          main: {
            workspace: storedWorkspace,
            identity: {
              name: "C-3PO",
              theme: "Flustered Protocol Droid",
              emoji: "🤖",
              avatar: "avatars/c3po.png",
            },
          },
        },
      },
    });
    expect(JSON.parse(jsonRuntime.logs.at(-1) ?? "{}")).toEqual({
      agentId: "main",
      identity: {
        name: "C-3PO",
        theme: "Flustered Protocol Droid",
        emoji: "🤖",
        avatar: "avatars/c3po.png",
      },
      workspace,
      storedWorkspace,
      identityFile: identityPath,
    });

    const textRuntime = createCapturingTestRuntime();
    await agentsSetIdentityCommand(
      { agent: "main", identityFile: identityPath },
      textRuntime.runtime,
    );
    expect(textRuntime.logs).toContain(`Workspace: ${storedWorkspace}`);
    expect(textRuntime.logs).toContain(`Identity source: ${workspace}`);
    expect(textRuntime.logs.join("\n")).not.toContain("Relocate with");
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
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: {} } } }),
    );

    await agentsSetIdentityCommand(
      { agent: "main", avatar: "https://example.com/avatar.png" },
      runtime,
    );

    expect(getWrittenMainIdentity()).toEqual({
      avatar: "https://example.com/avatar.png",
    });
  });

  it.each(["ghostzzz", "агент✨", "   "])(
    "errors without changing config when --agent names %j",
    async (agent) => {
      configMocks.readConfigFileSnapshot.mockResolvedValue(
        createTestConfigSnapshot({ agents: { entries: { main: {} } } }),
      );

      await expectIdentityCommandFailure(
        { agent, name: "Ghost", json: true },
        `Agent "${agent}" not found. Create it with \`openclaw agents add\`.`,
      );
    },
  );

  it.each(["main", "openclaw", "crestodian"])(
    "does not create absent reserved agent %s",
    async (agentId) => {
      configMocks.readConfigFileSnapshot.mockResolvedValue(
        createTestConfigSnapshot({ agents: { entries: { ops: {} } } }),
      );

      await expectIdentityCommandFailure(
        { agent: agentId, name: "Hijack" },
        `Agent "${agentId}" not found. Create it with \`openclaw agents add\`.`,
      );
    },
  );

  it("rejects an unknown agent before attempting to read its explicit identity file", async () => {
    const { workspace } = await createIdentityWorkspace();
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: { workspace } } } }),
    );

    await expectIdentityCommandFailure(
      { agent: "ghost", identityFile: path.join(workspace, "missing.md"), json: true },
      'Agent "ghost" not found. Create it with `openclaw agents add`.',
    );
  });

  it("still updates a real existing agent", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: {
          entries: { ops: { identity: { emoji: "🛠️" } } },
        },
      }),
    );

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
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: {
          defaults: { workspace },
          entries: {},
        },
      }),
    );

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

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: {} } } }),
    );

    const originalIdentity = await fs.readFile(identityPath, "utf8");
    const error = await agentsSetIdentityCommand(
      { agent: "main", identityFile: identityPath, json: true },
      runtime,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExpectedCliError);
    const renderedError = (error as ExpectedCliError).message;
    expect(renderedError).toContain(
      `Identity file ${identityPath} exceeds the maximum size of ${TEST_MAX_IDENTITY_FILE_BYTES} bytes`,
    );
    expect(renderedError).toContain(`File exceeds ${TEST_MAX_IDENTITY_FILE_BYTES} bytes:`);
    expect(renderedError).toContain("too-large");
    expect((error as ExpectedCliError).humanOutput).toBe(renderedError);
    expect((error as ExpectedCliError).machineOutput).toBe(renderedError);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
  });

  it("errors when identity data is missing", async () => {
    const { workspace } = await createIdentityWorkspace();
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: { workspace } } } }),
    );

    await expectIdentityCommandFailure(
      { workspace, fromIdentity: true, json: true },
      `No identity data found in ${path.join(workspace, "IDENTITY.md")}.`,
    );
    await expect(fs.access(path.join(workspace, "IDENTITY.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves unexpected configuration write failures with the shared root owner", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({ agents: { entries: { main: {} } } }),
    );
    const writeFailure = new Error("configuration storage is unavailable");
    configMocks.replaceConfigFile.mockRejectedValueOnce(writeFailure);

    await expect(
      agentsSetIdentityCommand({ agent: "main", name: "Updated", json: true }, runtime),
    ).rejects.toBe(writeFailure);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not persist --workspace and reports the stored workspace separately", async () => {
    const { root, workspace: storedWorkspace } = await createIdentityWorkspace("stored");
    const workspaceLocator = path.join(root, "relocated");
    await fs.mkdir(workspaceLocator, { recursive: true });

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: { entries: { worker: { workspace: storedWorkspace } } },
      }),
    );

    const jsonRuntime = createCapturingTestRuntime();
    await agentsSetIdentityCommand(
      {
        agent: "worker",
        workspace: workspaceLocator,
        name: "Worker",
        json: true,
      },
      jsonRuntime.runtime,
    );

    const [written] = configMocks.writeConfigFile.mock.calls[0] ?? [];
    expect(written).toMatchObject({
      agents: {
        entries: {
          worker: {
            workspace: storedWorkspace,
            identity: { name: "Worker" },
          },
        },
      },
    });
    expect(JSON.parse(jsonRuntime.logs.at(-1) ?? "{}")).toEqual({
      agentId: "worker",
      identity: { name: "Worker" },
      workspace: workspaceLocator,
      storedWorkspace,
      identityFile: null,
    });
  });

  it("quotes the relocation hint when the locator path contains spaces", async () => {
    const { root, workspace: storedWorkspace } = await createIdentityWorkspace("stored");
    const workspaceLocator = path.join(root, "My workspace");
    await fs.mkdir(workspaceLocator, { recursive: true });

    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: { entries: { worker: { workspace: storedWorkspace } } },
      }),
    );

    const { runtime: capturingRuntime, logs } = createCapturingTestRuntime();
    await agentsSetIdentityCommand(
      {
        agent: "worker",
        workspace: workspaceLocator,
        name: "Worker",
      },
      capturingRuntime,
    );

    expect(logs).toContain(`Workspace: ${storedWorkspace}`);
    expect(logs).toContain(`Workspace locator: ${workspaceLocator}`);
    expect(logs).toContain(
      `Stored workspace unchanged. Relocate with ${formatCliCommand(
        `openclaw config set agents.entries.worker.workspace ${quoteCliArg(workspaceLocator)}`,
      )}.`,
    );
    expect(logs.join("\n")).not.toContain("Identity source:");
  });
});
