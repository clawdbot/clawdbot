import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileTransferAudit } from "./audit.js";

describe("file-transfer audit diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes append failures through captured console diagnostics", async () => {
    await withTempDir("openclaw-file-transfer-audit-", async (root) => {
      const homeFile = path.join(root, "home-file");
      await fs.writeFile(homeFile, "not a directory", "utf8");
      vi.spyOn(os, "homedir").mockReturnValue(homeFile);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await appendFileTransferAudit({
        op: "file.fetch",
        nodeId: "test-node",
        requestedPath: "/tmp/example",
        decision: "error",
      });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[file-transfer:audit] append failed"),
      );
    });
  });
});
