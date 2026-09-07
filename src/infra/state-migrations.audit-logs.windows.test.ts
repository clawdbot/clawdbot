import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  configAuditRecord,
  systemAuditEvent,
  withAuditMigrationFixture,
} from "./state-migrations.audit.test-support.js";

describe.skipIf(process.platform !== "win32")("legacy audit migration on Windows", () => {
  afterEach(resetPluginStateStoreForTests);

  it("secures and imports both legacy audit logs without read-only fsync failures", async () => {
    await withAuditMigrationFixture(async (audit) => {
      try {
        await audit.writeJsonLines(audit.config.source, [configAuditRecord("windows-fsync")]);
        await audit.writeJsonLines(audit.system.source, [systemAuditEvent("Windows migration")]);

        const result = await audit.migrate();

        expect(result.warnings).toEqual([]);
        expect(audit.detect().hasLegacy).toBe(false);
      } finally {
        resetPluginStateStoreForTests();
      }
    });
  });
});
