import fs from "node:fs/promises";
import type { Server } from "node:http";
import { setImmediate } from "node:timers/promises";
import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi, type TestContext } from "vitest";
import { createDeferred } from "./promise.js";

it.for(["cancelled import", "failed import", "failed evidence", "cancelled close"] as const)(
  "joins generation work before reset and the next case (%s)",
  (fault, context) => {
    const work = Promise.resolve().then(async () => {
      const after: Array<() => unknown> = [];
      const cases: Array<(context: TestContext) => Promise<unknown>> = [];
      const gate = createDeferred();
      const importing = createDeferred();
      const controller = new AbortController();
      const reason = new Error(`injected ${fault}`);
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const servers: Server[] = [];
      let firstCase = true;
      const resets: boolean[] = [];
      const writes: Array<{ artifactBase: string; details?: string }> = [];
      const roots = new Set<string>();
      const argv = process.argv;
      const exitCode = process.exitCode;
      const tmpdir = process.env.TMPDIR;
      const remove = fs.rm;
      let released = false;
      let first: Promise<unknown> | undefined;
      let teardown: Promise<unknown> | undefined;
      const mocks = new Set<string>();
      const realDoMock = vi.doMock.bind(vi);
      const record = (_name: string, body: (context: TestContext) => Promise<unknown>) => {
        cases.push(body);
      };
      const captureIt = Object.assign(record, {
        each: (values: string[]) => (_name: string, body: (value: string) => Promise<unknown>) => {
          for (const value of values) {
            cases.push(() => body(value));
          }
        },
        for:
          (values: string[]) =>
          (_name: string, body: (value: string, context: TestContext) => Promise<unknown>) => {
            for (const value of values) {
              cases.push((ctx) => body(value, ctx));
            }
          },
      });
      vi.doMock("vitest", () => ({
        expect,
        describe: (_name: string, body: () => void) => body(),
        it: captureIt,
        afterEach: (hook: () => unknown) => after.push(hook),
        vi: {
          ...vi,
          doMock: (id: string, factory: Parameters<typeof vi.doMock>[1]) => {
            mocks.add(id);
            if (typeof factory !== "function") {
              realDoMock(id, factory);
            } else if (id.endsWith("/script-evidence.js")) {
              realDoMock(id, async (importOriginal) => {
                const original = (await factory(
                  importOriginal,
                )) as typeof import("../e2e/qa-lab/runtime/script-evidence.js");
                return {
                  createQaScriptEvidenceWriter: (
                    options: Parameters<typeof original.createQaScriptEvidenceWriter>[0],
                  ) => {
                    const writer = original.createQaScriptEvidenceWriter(options);
                    return {
                      ...writer,
                      async write(result: Parameters<typeof writer.write>[0]) {
                        writes.push({ artifactBase: options.artifactBase, ...result });
                        if (firstCase && fault === "failed evidence") {
                          throw reason;
                        }
                        return await writer.write(result);
                      },
                    };
                  },
                };
              });
            } else if (id.endsWith("/paired-node-worker-wire-fixture.js")) {
              realDoMock(id, async (importOriginal) => {
                const original = (await factory(
                  importOriginal,
                )) as typeof import("../e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js");
                return {
                  ...original,
                  async closeWireServer(server: Server) {
                    servers.push(server);
                    if (firstCase && fault === "cancelled close") {
                      controller.abort(reason);
                    }
                    await original.closeWireServer(server);
                  },
                };
              });
            } else {
              realDoMock(id, factory);
            }
          },
          doUnmock: (id: string) => {
            resets.push(released);
            // Record premature reset without letting pre-fix code start real services.
            if (released) {
              vi.doUnmock(id);
            }
          },
          restoreAllMocks: () => {
            if (released) {
              vi.restoreAllMocks();
            }
          },
          unstubAllEnvs: () => {
            if (released) {
              vi.unstubAllEnvs();
            }
          },
          resetModules: () => {
            if (released) {
              vi.resetModules();
            }
          },
          stubEnv: (key: string, value: string) => {
            if (key === "TMPDIR") {
              roots.add(value);
            }
            return vi.stubEnv(key, value);
          },
        },
      }));
      vi.doMock("../e2e/qa-lab/runtime/worker-inference-generation-reload.js", async (original) => {
        console.log(`lifecycle: ${fault} import barrier reached`);
        importing.resolve();
        await gate.promise;
        if (fault === "failed import") {
          throw reason;
        }
        return await original();
      });
      const firstContext = { ...context, signal };
      try {
        await import("./qa-gateway-cleanup.test.js");
        first = cases[0]!(firstContext).catch((error: unknown) => error);
        await Promise.race([
          importing.promise,
          first.then(() => {
            throw new Error("generation case ended before the import barrier");
          }),
        ]);
        if (fault === "cancelled import") {
          controller.abort(reason);
        }
        // Vitest enters afterEach when its cancellation wrapper rejects, while the
        // original body is still pending. The last hook owns reset in both versions.
        let teardownDone = false;
        teardown = Promise.resolve(after.at(-1)!()).then(() => {
          teardownDone = true;
        });
        await setImmediate();
        const resetBeforeJoin = resets.includes(false);
        const completedBeforeJoin = teardownDone;
        released = true;
        gate.resolve();
        const outcome = await first;
        await teardown;
        // The old temp tracker has a separate earlier hook; run it only after join.
        for (const hook of after.slice(0, -1)) {
          await hook();
        }
        const firstWrites = [...writes];
        console.log(
          JSON.stringify({
            fault,
            resetBeforeJoin,
            completedBeforeJoin,
            firstWrites: firstWrites.length,
          }),
        );
        vi.doUnmock("../e2e/qa-lab/runtime/worker-inference-generation-reload.js");
        for (const id of mocks) {
          vi.doUnmock(id);
        }
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.resetModules();
        firstCase = false;
        await cases[1]!(context);
        for (const hook of after.toReversed()) {
          await hook();
        }
        expect(resetBeforeJoin).toBe(false);
        expect(completedBeforeJoin).toBe(false);
        expect(collectErrorGraphCandidates(outcome, (error) => [error.cause])).toContain(reason);
        const firstWriteCount = fault === "failed evidence" || fault === "cancelled close" ? 1 : 0;
        expect(firstWrites).toHaveLength(firstWriteCount);
        expect(writes).toHaveLength(firstWriteCount + 1);
        expect(writes.at(-1)?.details).toContain("generation shutdown unconfirmed");
        expect(servers).toHaveLength(firstWriteCount + 1);
        for (const server of servers) {
          expect(server.listening).toBe(false);
          expect(
            await new Promise<number>((resolve, reject) => {
              server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
            }),
          ).toBe(0);
        }
        expect(process.argv).toBe(argv);
        expect(process.exitCode).toBe(exitCode);
        expect(process.env.TMPDIR).toBe(tmpdir);
        expect(fs.rm).toBe(remove);
        const [firstRoot, secondRoot] = [...roots];
        expect(writes.at(-1)?.artifactBase).toBe(`${secondRoot}/evidence`);
        for (const write of firstWrites) {
          expect(write.artifactBase).toBe(`${firstRoot}/evidence`);
        }
        for (const root of roots) {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        released = true;
        gate.resolve();
        try {
          await first;
          await teardown;
        } finally {
          for (const id of [
            "vitest",
            "../e2e/qa-lab/runtime/worker-inference-generation-reload.js",
            ...mocks,
          ]) {
            vi.doUnmock(id);
          }
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          vi.resetModules();
          process.argv = argv;
          process.exitCode = exitCode;
          for (const root of roots) {
            await fs.rm(root, { recursive: true, force: true });
          }
        }
      }
    });
    context.onTestFinished(() =>
      work.then(
        () => {},
        () => {},
      ),
    );
    return work;
  },
);
