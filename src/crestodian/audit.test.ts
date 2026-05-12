import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendCrestodianAuditEntry, resolveCrestodianAuditPath } from "./audit.js";

describe("Crestodian audit log", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("writes jsonl records under the OpenClaw audit dir", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-audit-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);

    const auditPath = await appendCrestodianAuditEntry({
      operation: "config.setDefaultModel",
      summary: "Set default model to openai/gpt-5.2",
      configHashBefore: "before",
      configHashAfter: "after",
    });

    expect(auditPath).toBe(resolveCrestodianAuditPath());
    const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.operation).toBe("config.setDefaultModel");
    expect(entry.summary).toBe("Set default model to openai/gpt-5.2");
    expect(entry.configHashBefore).toBe("before");
    expect(entry.configHashAfter).toBe("after");
  });
});
