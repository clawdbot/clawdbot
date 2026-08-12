import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let workspaceDir = "";
let configOverride = createSubagentSpawnTestConfig();
let subagentSpawnModule: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

beforeAll(async () => {
  subagentSpawnModule = await loadSubagentSpawnModuleForTest({
    callGatewayMock,
    getRuntimeConfig: () => configOverride,
    updateSessionStoreMock,
    workspaceDir: os.tmpdir(),
  });
});

describe("spawnSubagentDirect attachment validation", () => {
  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-attachment-validation-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    configOverride = createSubagentSpawnTestConfig(workspaceDir);
    subagentSpawnModule.resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    updateSessionStoreMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "forum" as const,
    agentAccountId: "123",
    agentTo: "456",
  };

  it.each([
    ["empty", ""],
    ["bad padding", "abc"],
    ["invalid characters", "!@#$"],
    ["whitespace only", "   "],
    ["pre-decode oversize", "A".repeat(2737)],
    ["decoded oversize", Buffer.alloc(1025, 0x42).toString("base64")],
  ])("rejects %s base64 attachments through the spawn boundary", async (_label, content) => {
    configOverride = createSubagentSpawnTestConfig(workspaceDir, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: true,
            maxFiles: 50,
            maxFileBytes: 1024,
            maxTotalBytes: 5 * 1024 * 1024,
          },
        },
      },
    });
    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.bin", content, encoding: "base64" }],
      },
      ctx,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("attachments_invalid_base64_or_too_large"),
    });
  });

  it.each([
    ["path separator", "foo/bar"],
    ["parent traversal", ".."],
    ["reserved manifest", ".manifest.json"],
    ["newline", "foo\nbar"],
    ["empty", ""],
  ])("rejects %s attachment names", async (_label, name) => {
    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name, content: Buffer.from("hello").toString("base64"), encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("rejects duplicate names", async () => {
    const attachment = {
      name: "file.txt",
      content: Buffer.from("hello").toString("base64"),
      encoding: "base64" as const,
    };
    const result = await subagentSpawnModule.spawnSubagentDirect(
      { task: "test", attachments: [attachment, attachment] },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });
});
