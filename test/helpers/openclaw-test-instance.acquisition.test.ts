import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../../src/test-utils/env.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

describe("createOpenClawTestInstance acquisition", () => {
  it.each(["merge", "serialization", "write"] as const)(
    "releases acquired state when initial config %s fails",
    async (stage) => {
      const previousEnv = { ...process.env };
      const snapshot = captureFullEnv();
      const failure = new Error(`config ${stage} failed`);
      let root: string | undefined;
      let writeFailure: unknown;
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        const allocated = await mkdtemp(...args);
        if (args[0].endsWith("instance-wrapper-failure-")) {
          root = await fs.realpath(allocated);
        }
        return allocated;
      });
      const writeFile = fs.writeFile;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (
          stage === "write" &&
          root &&
          args[0] === path.join(root, "home", ".openclaw", "openclaw.json")
        ) {
          // A directory at the config path makes the real filesystem write reject.
          await fs.mkdir(args[0]);
          try {
            await writeFile(...args);
          } catch (error) {
            writeFailure = error;
            throw error;
          }
          return;
        }
        return writeFile(...args);
      });
      const failConfig = () => {
        expect(root).toBeDefined();
        throw failure;
      };
      const config =
        stage === "merge"
          ? {
              get gateway() {
                return failConfig();
              },
            }
          : stage === "serialization"
            ? { toJSON: failConfig }
            : {};
      try {
        const rejected = await createOpenClawTestInstance({
          name: "acquisition-failure",
          port: 12345,
          state: { prefix: "instance-wrapper-failure-" },
          config,
        }).catch((error: unknown) => error);
        if (stage === "write") {
          expect(writeFailure).toMatchObject({ code: "EISDIR" });
          expect(rejected).toBe(writeFailure);
        } else {
          expect(rejected).toBe(failure);
        }
        expect(process.env).toEqual(previousEnv);
        expect(root).toBeDefined();
        await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        allocationSpy.mockRestore();
        writeSpy.mockRestore();
        snapshot.restore();
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});
