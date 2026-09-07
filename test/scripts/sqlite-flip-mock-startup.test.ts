import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../../src/test-utils/env.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.js";
import { stopChildProcess } from "../helpers/stop-child-process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../../src/test-utils/openclaw-test-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/test-utils/openclaw-test-state.js")>();
  return { ...actual, createOpenClawTestState: vi.fn(actual.createOpenClawTestState) };
});
vi.mock("../helpers/openclaw-test-instance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/openclaw-test-instance.js")>();
  return { ...actual, createOpenClawTestInstance: vi.fn(actual.createOpenClawTestInstance) };
});
vi.mock("../helpers/stop-child-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/stop-child-process.js")>();
  return { ...actual, stopChildProcess: vi.fn(actual.stopChildProcess) };
});

async function tryBind(port: number) {
  const competitor = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      competitor.once("error", reject);
      competitor.listen(port, "127.0.0.1", resolve);
    });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (competitor.listening) {
      await new Promise<void>((resolve, reject) => {
        competitor.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe("SQLite flip mock endpoint ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "owns the first published endpoint and handles config failure (unverified stop=%s)",
    async (unverifiedStop) => {
      const envSnapshot = captureFullEnv();
      process.env.ANTHROPIC_API_KEY = "ambient-provider-fixture";
      const previousEnv = { ...process.env };
      const actualState = await vi.importActual<
        typeof import("../../src/test-utils/openclaw-test-state.js")
      >("../../src/test-utils/openclaw-test-state.js");
      const actualInstance = await vi.importActual<
        typeof import("../helpers/openclaw-test-instance.js")
      >("../helpers/openclaw-test-instance.js");
      const actualStop = await vi.importActual<typeof import("../helpers/stop-child-process.js")>(
        "../helpers/stop-child-process.js",
      );
      const configFailure = new Error("fixture configuration write failed");
      const stopFailure = new Error("mock process closure could not be verified");
      let instance: OpenClawTestInstance | undefined;
      let publishedPort: number | undefined;
      let competingBind: unknown;
      let requestLog = "";
      let initialConfig: Record<string, unknown> | undefined;
      let publishedConfig: Record<string, unknown> | undefined;
      let childEnv: NodeJS.ProcessEnv | undefined;
      let publicationCount = 0;
      const cli = vi.fn(async (): Promise<never> => {
        throw new Error("CLI ran before configuration completed");
      });
      vi.mocked(createOpenClawTestState).mockImplementation(async (options) => {
        const state = await actualState.createOpenClawTestState(options);
        const writeConfig = state.writeConfig;
        state.writeConfig = async (config) => {
          const record = asRecord(config);
          const provider = asRecord(asRecord(asRecord(record?.models)?.providers)?.openai);
          if (typeof provider?.baseUrl !== "string") {
            initialConfig = record;
            return writeConfig(config);
          }
          publicationCount++;
          publishedConfig = record;
          publishedPort = Number(new URL(provider.baseUrl).port);
          const mockSpawn = vi
            .mocked(spawn)
            .mock.calls.find(
              ([, args]) => Array.isArray(args) && args[0] === "scripts/e2e/mock-openai-server.mjs",
            );
          childEnv = mockSpawn?.[2]?.env;
          competingBind = await tryBind(publishedPort);
          if (asRecord(competingBind)?.code === "EADDRINUSE") {
            const response = await fetch(`${provider.baseUrl}/responses`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ input: "mock startup proof" }),
            });
            expect(response.status).toBe(200);
            expect(await response.text()).toContain("OPENCLAW_E2E_OK_12");
            requestLog = await fs.readFile(state.statePath("mock-openai-requests.ndjson"), "utf8");
          }
          throw configFailure;
        };
        return state;
      });
      vi.mocked(createOpenClawTestInstance).mockImplementation(async (options) => {
        instance = await actualInstance.createOpenClawTestInstance(options);
        instance.cli = cli;
        instance.entrypoint = cli;
        return instance;
      });
      vi.mocked(stopChildProcess).mockImplementation(
        unverifiedStop
          ? async () => {
              throw stopFailure;
            }
          : actualStop.stopChildProcess,
      );

      try {
        const result = await runSqliteSessionsTranscriptsFlipProof().catch(
          (error: unknown) => error,
        );
        expect(publicationCount).toBe(1);
        expect(competingBind).toMatchObject({ code: "EADDRINUSE" });
        expect(initialConfig).toBeDefined();
        expect(publishedConfig).toMatchObject({
          gateway: { ...asRecord(initialConfig?.gateway), mode: "local" },
          hooks: initialConfig?.hooks,
        });
        expect(requestLog).toContain("mock startup proof");
        expect(cli).not.toHaveBeenCalled();
        expect(Object.keys(process.env).toSorted()).toEqual(Object.keys(previousEnv).toSorted());
        expect(
          Object.keys(previousEnv).filter((key) => process.env[key] !== previousEnv[key]),
        ).toEqual([]);
        expect(instance).toBeDefined();
        expect({ HOME: childEnv?.HOME, OPENCLAW_STATE_DIR: childEnv?.OPENCLAW_STATE_DIR }).toEqual({
          HOME: instance!.homeDir,
          OPENCLAW_STATE_DIR: instance!.stateDir,
        });
        expect(childEnv?.OPENAI_API_KEY === "sk-openclaw-e2e-mock").toBe(true);
        expect(childEnv?.ANTHROPIC_API_KEY).toBeUndefined();
        if (unverifiedStop) {
          expect(result).toBeInstanceOf(AggregateError);
          expect((result as AggregateError).errors[0]).toBe(configFailure);
          await expect(fs.stat(instance!.stateDir)).resolves.toBeDefined();
          expect(await tryBind(publishedPort!)).toMatchObject({ code: "EADDRINUSE" });
        } else {
          expect(result).toMatchObject({
            ok: false,
            failures: [expect.stringContaining(configFailure.message)],
          });
          await expect(fs.stat(instance!.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await tryBind(publishedPort!)).toBeUndefined();
        }
      } finally {
        for (const [child, timeout] of vi.mocked(stopChildProcess).mock.calls) {
          await actualStop.stopChildProcess(child, timeout);
        }
        await instance?.cleanup();
        vi.mocked(createOpenClawTestState).mockReset();
        vi.mocked(createOpenClawTestInstance).mockReset();
        vi.mocked(stopChildProcess).mockReset();
        vi.mocked(spawn).mockClear();
        envSnapshot.restore();
      }
    },
  );
});
