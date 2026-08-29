import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupQaGatewayTempRoots } from "./gateway-child-artifacts.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const dirs = createTempDirHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await dirs.cleanup();
});

describe("cleanupQaGatewayTempRoots", () => {
  // Short messages expose cause leaks that padding could hide behind truncation.
  it.each([
    { failedRoots: ["tempRoot"], padding: "" },
    { failedRoots: ["stagedBundledPluginsRoot"], padding: "" },
    { failedRoots: ["tempRoot", "stagedBundledPluginsRoot"], padding: "diagnostic ".repeat(400) },
  ])(
    "reports $failedRoots failures after attempting both roots",
    async ({ failedRoots, padding }) => {
      const roots = {
        tempRoot: await dirs.makeTempDir("qa-cleanup-runtime-"),
        stagedBundledPluginsRoot: await dirs.makeTempDir("qa-cleanup-plugins-"),
      };
      const originalRm = fs.rm;
      const attempts: string[] = [];
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        const entry = Object.entries(roots).find(([, root]) => root === target);
        if (entry) {
          attempts.push(entry[0]);
          if (failedRoots.includes(entry[0])) {
            throw Object.assign(
              new Error(`EACCES: denied apiKey=synthetic-cleanup-secret\n${padding}`),
              { code: "EACCES", path: target, cause: new Error("synthetic-raw-cause") },
            );
          }
        }
        return originalRm(target, options);
      });

      const outcome = await cleanupQaGatewayTempRoots(roots).catch((error: unknown) => error);
      expect(attempts).toEqual(Object.keys(roots));
      for (const [label, root] of Object.entries(roots)) {
        if (failedRoots.includes(label)) {
          await expect(fs.stat(root)).resolves.toBeDefined();
        } else {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError)) {
        throw new Error("expected cleanup failure");
      }
      expect(outcome.errors).toHaveLength(failedRoots.length);
      for (const label of failedRoots) {
        expect(outcome.message).toContain(label);
      }
      expect(outcome.message).toContain("EACCES");
      expect(outcome.message.length).toBeLessThan(4_500);
      expect(inspect(outcome, { depth: null })).not.toMatch(
        /synthetic-cleanup-secret|synthetic-raw-cause/,
      );
    },
  );

  it.each([undefined, null, "missing"])(
    "accepts an already removed runtime with staged root %s",
    async (staging) => {
      const parent = await dirs.makeTempDir("qa-cleanup-absent-");
      await expect(
        cleanupQaGatewayTempRoots({
          tempRoot: path.join(parent, "runtime"),
          stagedBundledPluginsRoot: staging ? path.join(parent, staging) : staging,
        }),
      ).resolves.toBeUndefined();
    },
  );
});
