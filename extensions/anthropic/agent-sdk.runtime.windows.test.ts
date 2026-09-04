import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeAgentSdk } from "./agent-sdk.runtime.js";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "b7c9d2e4-1f3a-4b5c-9d0e-2a4b6c8d0e1f",
};

function createContext(command: string, env: Record<string, string>): CliBackendExecuteContext {
  return {
    command,
    args: ["-p", "--output-format", "stream-json"],
    cwd: "/tmp/openclaw-workspace",
    env,
    prompt: "Reply with the launch code.",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "Follow the OpenClaw execution policy.",
    useResume: false,
    timeoutMs: 30_000,
    executionMode: "agent",
    requestToolPermission: vi.fn(async () => ({
      behavior: "deny" as const,
      message: "OpenClaw denied this action.",
    })),
    requestUserInput: vi.fn(async () => ({
      status: "cancelled" as const,
      message: "OpenClaw cancelled this question.",
    })),
  };
}

function sdkOptions(): Record<string, unknown> {
  const call = queryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
  expect(call?.options).toBeDefined();
  return call?.options ?? {};
}

afterEach(() => {
  queryMock.mockReset();
  vi.restoreAllMocks();
});

describe("Anthropic Agent SDK runtime Windows executable resolution", () => {
  it("hands the SDK the resolved native entrypoint instead of the unspawnable shim", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-sdk-win-"));
    const packageBin = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(packageBin, { recursive: true });
    const nativeBinary = path.join(packageBin, "claude.exe");
    await writeFile(nativeBinary, "fake-native-binary");
    const extensionlessShim = path.join(prefix, "claude");
    await writeFile(extensionlessShim, "#!/bin/sh\nexec node cli.js\n");
    await writeFile(
      path.join(prefix, "claude.cmd"),
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
        "",
      ].join("\r\n"),
    );
    queryMock.mockImplementation(() => {
      const stream = (async function* () {
        yield SUCCESS_RESULT;
      })();
      return Object.assign(stream, { close: vi.fn() });
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const context = createContext(extensionlessShim, {
        PATH: prefix,
        PATHEXT: ".EXE;.CMD;.BAT;.COM",
      });

      for await (const _ of executeClaudeAgentSdk(context)) {
        // Drain the mocked SDK stream to completion.
      }

      expect(sdkOptions()).toEqual(
        expect.objectContaining({ pathToClaudeCodeExecutable: nativeBinary }),
      );
    } finally {
      platformSpy.mockRestore();
      await rm(prefix, { recursive: true, force: true });
    }
  });
});
