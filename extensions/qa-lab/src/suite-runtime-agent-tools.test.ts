import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn(async () => undefined));
const listToolsMock = vi.hoisted(() => vi.fn(async () => ({ tools: [] })));
const callToolMock = vi.hoisted(() => vi.fn(async () => ({ content: [] })));
const closeMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/node"));
const stdioTransportMock = vi.hoisted(() =>
  vi.fn().mockImplementation(function StdioClientTransport(
    this: { params?: unknown },
    params: unknown,
  ) {
    this.params = params;
  }),
);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi
    .fn()
    .mockImplementation(
      function Client(this: {
        connect?: typeof connectMock;
        listTools?: typeof listToolsMock;
        callTool?: typeof callToolMock;
        close?: typeof closeMock;
      }) {
        this.connect = connectMock;
        this.listTools = listToolsMock;
        this.callTool = callToolMock;
        this.close = closeMock;
      },
    ),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: stdioTransportMock,
}));

vi.mock("./node-exec.js", () => ({
  resolveQaNodeExecPath: resolveQaNodeExecPathMock,
}));

import {
  callPluginToolsMcp,
  findSkill,
  handleQaAction,
  writeWorkspaceSkill,
} from "./suite-runtime-agent-tools.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("qa suite runtime agent tools helpers", () => {
  beforeEach(() => {
    connectMock.mockClear();
    listToolsMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockClear();
    resolveQaNodeExecPathMock.mockClear();
    stdioTransportMock.mockClear();
  });

  it("finds a skill by exact name", () => {
    expect(findSkill([{ name: "alpha" }, { name: "beta" }], "beta")).toEqual({ name: "beta" });
    expect(findSkill([{ name: "alpha" }], "beta")).toBeUndefined();
  });

  it("writes a workspace skill under the gateway workspace", async () => {
    const workspaceDir = await makeTempDir("qa-workspace-");

    const skillPath = await writeWorkspaceSkill({
      env: { gateway: { workspaceDir } } as never,
      name: "my-skill",
      body: "hello world",
    });

    await expect(fs.readFile(skillPath, "utf8")).resolves.toBe("hello world\n");
    expect(skillPath).toBe(path.join(workspaceDir, "skills", "my-skill", "SKILL.md"));
  });

  it("routes generic transport actions through the payload extractor", async () => {
    const handleAction = vi.fn(async () => ({
      content: [{ type: "text", text: "done" }],
    }));

    await expect(
      handleQaAction({
        env: {
          cfg: {} as never,
          transport: { handleAction },
        } as never,
        action: "react",
        args: { messageId: "1", emoji: ":+1:" },
      }),
    ).resolves.toEqual("done");
  });

  it("calls plugin-tools MCP through the resolved node executable", async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [{ name: "plugin.echo" }] as never[],
    });
    callToolMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "echoed" }] as never[],
    });

    await expect(
      callPluginToolsMcp({
        env: {
          gateway: {
            runtimeEnv: {
              PATH: "/usr/bin",
              OPENCLAW_KEY: "1",
              EMPTY: undefined,
            },
          },
        } as never,
        toolName: "plugin.echo",
        args: { text: "hello" },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "echoed" }],
    });

    expect(stdioTransportMock).toHaveBeenCalledWith({
      command: "/usr/bin/node",
      args: ["--import", "tsx", "src/mcp/plugin-tools-serve.ts"],
      stderr: "pipe",
      env: {
        PATH: "/usr/bin",
        OPENCLAW_KEY: "1",
      },
    });
    expect(callToolMock).toHaveBeenCalledWith({
      name: "plugin.echo",
      arguments: { text: "hello" },
    });
    expect(closeMock).toHaveBeenCalled();
  });
});
