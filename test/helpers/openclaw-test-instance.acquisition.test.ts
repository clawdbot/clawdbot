import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../../src/test-utils/env.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

describe("createOpenClawTestInstance acquisition", () => {
  it.each(["state", "merge", "serialization", "write", "cleanup"] as const)(
    "cleans up available resources after %s acquisition failure",
    async (stage) => {
      const previousEnv = { ...process.env };
      const snapshot = captureFullEnv();
      const failure = new Error(`config ${stage} failed`);
      let root: string | undefined;
      let writeFailure: unknown;
      const cleanupFailure = new Error("state cleanup failed");
      const serverSpy = vi.spyOn(net, "createServer");
      let reservedPort: number | undefined;
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        if (args[0].endsWith("instance-wrapper-failure-")) {
          const address = serverSpy.mock.results[0]?.value.address();
          reservedPort = address && typeof address !== "string" ? address.port : undefined;
          expect(reservedPort).toBeTypeOf("number");
          if (stage === "state") {
            throw failure;
          }
        }
        const allocated = await mkdtemp(...args);
        if (args[0].endsWith("instance-wrapper-failure-")) {
          root = await fs.realpath(allocated);
        }
        return allocated;
      });
      const rm = fs.rm;
      const cleanupSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (stage === "cleanup" && args[0] === root) {
          throw cleanupFailure;
        }
        return rm(...args);
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
        stage === "merge" || stage === "cleanup"
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
          state: { prefix: "instance-wrapper-failure-" },
          config,
        }).catch((error: unknown) => error);
        if (stage === "write") {
          expect(writeFailure).toMatchObject({ code: "EISDIR" });
          expect(rejected).toBe(writeFailure);
        } else if (stage === "cleanup") {
          expect(rejected).toBeInstanceOf(AggregateError);
          expect((rejected as AggregateError).errors).toEqual([failure, cleanupFailure]);
        } else {
          expect(rejected).toBe(failure);
        }
        expect(process.env).toEqual(previousEnv);
        if (stage !== "state") {
          expect(root).toBeDefined();
          if (stage === "cleanup") {
            await expect(fs.stat(root!)).resolves.toBeDefined();
          } else {
            await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
        const competitor = net.createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            competitor.once("error", reject);
            competitor.listen(reservedPort!, "127.0.0.1", resolve);
          });
        } finally {
          if (competitor.listening) {
            await new Promise<void>((resolve, reject) => {
              competitor.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
      } finally {
        allocationSpy.mockRestore();
        writeSpy.mockRestore();
        cleanupSpy.mockRestore();
        serverSpy.mockRestore();
        snapshot.restore();
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});
