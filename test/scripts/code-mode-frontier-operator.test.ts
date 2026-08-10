import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodeModeFrontierTaskDescriptors,
  parseCodeModeFrontierOptions,
  runCodeModeFrontierMatrix,
} from "../../scripts/code-mode-frontier-matrix.js";
import { comparableFrontierProof, frontierEnvelope } from "./code-mode-frontier-matrix.fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-frontier-operator-"));
  roots.push(root);
  return root;
}

describe("Code Mode frontier operator", () => {
  it("parses one explicit supported-frontier command contract", () => {
    expect(
      parseCodeModeFrontierOptions(
        [
          "--",
          "--model",
          "openai/gpt-test",
          "--api",
          "responses",
          "--campaign-id",
          "campaign-01",
          "--block-id",
          "block-01",
          "--execution-proof",
          "proof.json",
          "--model-capability",
          "capability.json",
        ],
        "/repo",
      ),
    ).toMatchObject({
      model: "openai/gpt-test",
      api: "responses",
      tasks: ["read", "dependent-read-write"],
      thinking: "off",
      timeoutSeconds: 180,
      sampling: { seed: "unset", seedSupport: "unsupported" },
      repoRoot: "/repo",
    });
  });

  it("binds canonical task fixture, prompt, and oracle digests", () => {
    const descriptors = buildCodeModeFrontierTaskDescriptors(["read", "dependent-read-write"]);
    expect(descriptors).toHaveLength(2);
    expect(descriptors.every((entry) => /^[a-f0-9]{64}$/u.test(entry.fixtureSha256))).toBe(true);
    expect(new Set(descriptors.map((entry) => entry.promptSha256)).size).toBe(2);
    expect(new Set(descriptors.map((entry) => entry.oracleSha256)).size).toBe(2);
  });

  it("drives the frozen production artifact through isolated agent cells", async () => {
    const repoRoot = await tempRoot();
    await fs.writeFile(
      path.join(repoRoot, "proof.json"),
      `${JSON.stringify({ ...comparableFrontierProof, unexpected: "must-not-persist" })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "capability.json"),
      `${JSON.stringify({
        api: "responses",
        model: "openai/gpt-test",
        seedSupport: "unsupported",
        supportedFrontier: true,
        credential: "must-not-persist",
      })}\n`,
      "utf8",
    );
    const runDate = new Date().toISOString().slice(0, 10);
    const result = await runCodeModeFrontierMatrix(
      parseCodeModeFrontierOptions(
        [
          "--model",
          "openai/gpt-test",
          "--api",
          "responses",
          "--campaign-id",
          "campaign-01",
          "--block-id",
          "block-01",
          "--execution-proof",
          "proof.json",
          "--model-capability",
          "capability.json",
          "--run-date",
          runDate,
          "--output-dir",
          "artifacts",
        ],
        repoRoot,
      ),
      {
        buildCliArtifacts: async () => {},
        hashRuntimeArtifacts: async () => "b".repeat(64),
        nonce: () => "one-use-campaign-nonce",
        prepareRuntimeEntrypoint: async () => ({ args: ["dist/entry.js"], cwd: repoRoot }),
        readFileSha256: async (filePath) =>
          filePath.endsWith("entry.js") ? "d".repeat(64) : "e".repeat(64),
        readSourceIdentity: async () => ({
          gitSha: "a".repeat(40),
          sourceDirty: false,
          sourcePatchSha256: null,
        }),
        runAgentCell: async ({ cell, fixture }) => {
          const envelope = JSON.parse(frontierEnvelope(cell.mode)) as {
            final: string;
            sessionId: string;
          };
          envelope.final = fixture.expected;
          envelope.sessionId = `operator-${cell.id}`;
          return {
            effectPassed: true,
            envelope,
            stdoutContractValid: true,
          };
        },
      },
    );

    expect(result.results).toHaveLength(8);
    expect(result.results.every((entry) => entry.passed)).toBe(true);
    expect(result.summary).toMatchObject({
      evidenceSource: "production",
      evidenceValid: true,
      bars: { allTasksPassed: true },
    });
    await expect(
      fs.access(path.join(repoRoot, "artifacts", "summary.json")),
    ).resolves.toBeUndefined();
    expect(
      await fs.readFile(path.join(repoRoot, "artifacts", "manifest.json"), "utf8"),
    ).not.toContain("must-not-persist");
  });
});
