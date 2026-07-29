// OpenClaw audit tests cover SQLite-backed rescue audit scenarios.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { appendSystemAgentAuditEntry, SYSTEM_AGENT_AUDIT_STORE_LABEL } from "./audit.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";

describe("OpenClaw audit log", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    resetPluginStateStoreForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("writes records into shared SQLite state", async () => {
    await withTempDir({ prefix: "openclaw-audit-" }, async (tempDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);

      const auditStore = await appendSystemAgentAuditEntry({
        operation: "config.setDefaultModel",
        summary: "Set default model to openai/gpt-5.2",
        configHashBefore: "before",
        configHashAfter: "after",
      });

      expect(auditStore).toBe(SYSTEM_AGENT_AUDIT_STORE_LABEL);
      const records = listSystemAgentAuditEntriesForTests();
      expect(records).toHaveLength(1);
      const entry = records[0]?.value;
      expect(entry).toBeDefined();
      if (!entry) {
        throw new Error("expected persisted system-agent audit entry");
      }
      expect(entry.operation).toBe("config.setDefaultModel");
      expect(entry.summary).toBe("Set default model to openai/gpt-5.2");
      expect(entry.configHashBefore).toBe("before");
      expect(entry.configHashAfter).toBe("after");
    });
  });
});
