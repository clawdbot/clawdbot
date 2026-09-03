import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { testing } from "./managed-gateway-service-lifecycle-product-proof.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const tempRoots: string[] = [];

afterEach(async () => {
  vi.mocked(spawnSync).mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("managed gateway service lifecycle evidence producer", () => {
  it("records failed evidence and exits nonzero when a child phase is signaled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-lifecycle-"));
    const artifactBase = path.join(root, "artifacts");
    tempRoots.push(root);
    vi.mocked(spawnSync).mockReturnValue({
      output: [null, null, null],
      pid: 123,
      signal: "SIGTERM",
      status: null,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    await expect(testing.main(["--artifact-base", artifactBase])).resolves.toBe(1);

    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(artifactBase, QA_EVIDENCE_FILENAME), "utf8")),
    );
    expect(evidence.entries[0]).toMatchObject({
      result: {
        failure: {
          reason: expect.stringContaining("terminated by signal SIGTERM"),
        },
        status: "fail",
      },
    });
    await expect(
      fs.readFile(path.join(artifactBase, "managed-gateway-service-lifecycle.log"), "utf8"),
    ).resolves.toContain("fail: foreground-cli-runtime terminated by signal SIGTERM");
  });
});
