import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runDiagnosticEventsBoundaryRuntime,
  testing,
} from "./diagnostic-events-boundary-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("diagnostic events boundary runtime", () => {
  it("composes async dispatch, trusted subscriptions, and model-call trace propagation", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostic-events-boundary-"));
    tempDirs.push(artifactBase);

    const { evidence, summary } = await runDiagnosticEventsBoundaryRuntime({
      artifactBase,
      repoRoot: process.cwd(),
    });

    expect(evidence.entries[0]?.result.status).toBe("pass");
    expect(summary).toMatchObject({
      deliveredBeforeDrain: 0,
      eventTypes: ["model.call.started", "model.call.completed"],
      failures: [],
      immutableEventCopies: true,
      passed: true,
      pendingBeforeDrain: true,
      privateEventCount: 2,
      publicEventTypes: ["message.queued"],
      trustedEventCount: 2,
    });
    expect(summary.propagatedTraceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/u,
    );
    const summaryText = await fs.readFile(
      path.join(artifactBase, "diagnostic-events-boundary-summary.json"),
      "utf8",
    );
    expect(summaryText).not.toContain("diagnostic-boundary-private-input");
    await expect(fs.stat(path.join(artifactBase, "qa-evidence.json"))).resolves.toBeDefined();
  });

  it("rejects missing output-dir values", () => {
    expect(() => testing.parseOptions(["--output-dir"])).toThrow("--output-dir requires a value");
  });
});
