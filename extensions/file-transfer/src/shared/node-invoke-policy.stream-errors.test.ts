// File Transfer tests cover archive-policy failures through the node invoke policy.
import crypto from "node:crypto";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectBoundedTextTail } from "./append-bounded-text-tail.js";

const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function mockCommandResult(overrides: Record<string, unknown> = {}) {
  runCommandWithTimeoutMock.mockImplementationOnce(
    async (
      _argv: string[],
      options: { onOutputChunk?: (chunk: Buffer, stream: string) => boolean | void },
    ) => {
      const stdout = typeof overrides.stdout === "string" ? overrides.stdout : "";
      const stopped = stdout
        ? options.onOutputChunk?.(Buffer.from(stdout), "stdout") === false
        : false;
      return commandResult({
        ...overrides,
        stdout: "",
        ...(stopped
          ? { code: null, killed: true, outputLimitExceeded: true, termination: "signal" }
          : {}),
      });
    },
  );
}

function createDirFetchContext(): OpenClawPluginNodeInvokePolicyContext {
  const archive = Buffer.from("archive");
  const invokeNode = vi
    .fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>()
    .mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/tmp/project",
        entries: ["ok.txt"],
        preflightOnly: true,
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/tmp/project",
        tarBase64: archive.toString("base64"),
        tarBytes: archive.byteLength,
        sha256: crypto.createHash("sha256").update(archive).digest("hex"),
        fileCount: 1,
      },
    });
  return {
    nodeId: "node-1",
    command: "dir.fetch",
    params: { path: "/tmp/project" },
    config: {},
    pluginConfig: {
      nodes: {
        "node-1": {
          allowReadPaths: ["/tmp/**"],
        },
      },
    },
    node: { nodeId: "node-1", displayName: "Node One" },
    invokeNode,
  };
}

async function runPolicy() {
  return await createFileTransferNodeInvokePolicy().handle(createDirFetchContext());
}

afterEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

describe("dir.fetch archive policy process wrapper", () => {
  it("fails archive listing closed on wrapper errors", async () => {
    runCommandWithTimeoutMock.mockRejectedValueOnce(new Error("policy listing read failed"));

    await expect(runPolicy()).resolves.toMatchObject({
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      message: expect.stringContaining("tar -tzf error: policy listing read failed"),
    });
  });

  it("normalizes successful archive entries", async () => {
    mockCommandResult({ stdout: "./ok.txt\n" });

    await expect(runPolicy()).resolves.toMatchObject({ ok: true });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ tolerateOutputError: { stderr: true } }),
    );
  });

  it("surfaces a UTF-16-safe stderr tail on nonzero exit", async () => {
    const oldNoise = "n".repeat(250);
    const recent = "🤖" + "f".repeat(199);
    mockCommandResult({ code: 2, stderr: oldNoise + recent });

    const result = await runPolicy();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected archive policy failure");
    }
    expect(result.message).toContain(projectBoundedTextTail(recent, 200));
    expect(result.message).not.toContain("🤖");
  });

  it("stops archive listing as soon as the entry cap is crossed", async () => {
    mockCommandResult({
      stdout: Array.from({ length: 5_001 }, (_, index) => `file-${index}`).join("\n") + "\n",
    });

    await expect(runPolicy()).resolves.toMatchObject({
      ok: false,
      code: "ARCHIVE_ENTRIES_TOO_MANY",
    });
  });
});
