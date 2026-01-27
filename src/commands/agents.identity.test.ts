import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

import { agentsSetIdentityCommand } from "./agents.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const baseSnapshot = {
  path: "/tmp/moltbot.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

describe("agents set-identity command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.writeConfigFile.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("sets identity from workspace IDENTITY.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-identity-"));
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      [
        "- Name: Clawd",
        "- Creature: helpful sloth",
        "- Emoji: :)",
        "- Avatar: avatars/clawd.png",
        "",
      ].join("\n"),
      "utf-8",
    );

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        agents: {
          list: [
            { id: "main", workspace },
            { id: "ops", workspace: path.join(root, "ops") },
          ],
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.identity).toEqual({
      name: "Clawd",
      theme: "helpful sloth",
      emoji: ":)",
      avatar: "avatars/clawd.png",
    });
  });

  it("errors when multiple agents match the same workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-identity-"));
    const workspace = path.join(root, "shared");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "- Name: Echo\n", "utf-8");

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        agents: {
          list: [
            { id: "main", workspace },
            { id: "ops", workspace },
          ],
        },
      },
    });

    await agentsSetIdentityCommand({ workspace }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Multiple agents match"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("overrides identity file values with explicit flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-identity-"));
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      [
        "- Name: Clawd",
        "- Theme: space lobster",
        "- Emoji: :)",
        "- Avatar: avatars/clawd.png",
        "",
      ].join("\n"),
      "utf-8",
    );

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main", workspace }] } },
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

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.identity).toEqual({
      name: "Nova",
      theme: "space lobster",
      emoji: "🦞",
      avatar: "https://example.com/override.png",
    });
  });

  it("reads identity from an explicit IDENTITY.md path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-identity-"));
    const workspace = path.join(root, "work");
    const identityPath = path.join(workspace, "IDENTITY.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      identityPath,
      [
        "- **Name:** C-3PO",
        "- **Creature:** Flustered Protocol Droid",
        "- **Emoji:** 🤖",
        "- **Avatar:** avatars/c3po.png",
        "",
      ].join("\n"),
      "utf-8",
    );

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand({ agent: "main", identityFile: identityPath }, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.identity).toEqual({
      name: "C-3PO",
      theme: "Flustered Protocol Droid",
      emoji: "🤖",
      avatar: "avatars/c3po.png",
    });
  });

  it("accepts avatar-only identity from IDENTITY.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-identity-"));
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      "- Avatar: avatars/only.png\n",
      "utf-8",
    );

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main", workspace }] } },
    });

    await agentsSetIdentityCommand({ workspace, fromIdentity: true }, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.identity).toEqual({
      avatar: "avatars/only.png",
    });
  });

  it("accepts avatar-only updates via flags", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main" }] } },
    });

    await agentsSetIdentityCommand(
      { agent: "main", avatar: "https://example.com/avatar.png" },
      runtime,
    );

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      agents?: { list?: Array<{ id: string; identity?: Record<string, string> }> };
    };
    const main = written.agents?.list?.find((entry) => entry.id === "main");
    expect(main?.identity).toEqual({
      avatar: "https://example.com/avatar.png",
    });
  });

  it("errors when identity data is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-identity-"));
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });

    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { agents: { list: [{ id: "main", workspace }] } },
    });

    await agentsSetIdentityCommand({ workspace, fromIdentity: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("No identity data found"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
