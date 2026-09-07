/**
 * The memory flush warning must reflect the final authorized tool list.
 * tools.deny and the rest of the policy pipeline run after the flush surface is
 * assembled, so a run can hold `write` there and still lose it before dispatch.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const warnings = vi.hoisted(() => [] as string[]);

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logWarn: (message: unknown, ...rest: unknown[]) => {
      warnings.push(String(message));
      return actual.logWarn(message as never, ...(rest as never[]));
    },
  };
});

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const MEMORY_PATH = "memory/2026-08-22.md";

describe("memory flush writer availability", () => {
  afterEach(() => {
    warnings.length = 0;
  });

  it("warns when tools.deny removes write after the flush surface is built", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-deny-"));
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: { tools: { deny: ["write"] } },
        trigger: "memory",
        memoryFlushWritePath: MEMORY_PATH,
        senderIsOwner: true,
      });

      expect(tools.some((tool) => tool.name === "write")).toBe(false);
      expect(
        warnings.some((line) => line.includes(`memory flush cannot persist ${MEMORY_PATH}`)),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("warns when the message-provider allowlist is what drops write", async () => {
    // TOOL_ALLOW_BY_MESSAGE_PROVIDER.node omits write, so this path loses the writer
    // without tools.deny being involved. The warning must not blame a config key here.
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-node-"));
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        trigger: "memory",
        memoryFlushWritePath: MEMORY_PATH,
        messageProvider: "node",
        senderIsOwner: true,
      });

      expect(tools.some((tool) => tool.name === "write")).toBe(false);
      const warned = warnings.find((line) => line.includes("memory flush cannot persist"));
      expect(warned).toBeDefined();
      expect(warned).not.toContain("tools.deny");
      expect(warned).not.toContain("tools.allow");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("stays quiet when the flush run keeps its writer", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-ok-"));
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        trigger: "memory",
        memoryFlushWritePath: MEMORY_PATH,
        senderIsOwner: true,
      });

      expect(tools.some((tool) => tool.name === "write")).toBe(true);
      expect(warnings.some((line) => line.includes("memory flush cannot persist"))).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
