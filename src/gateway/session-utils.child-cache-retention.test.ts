import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { sessionChildCacheRetentionEntrypoint } from "./session-child-cache-retention-entrypoint.test-support.js";

it("keeps child links without retaining released session metadata", async ({ signal }) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(sessionChildCacheRetentionEntrypoint)),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ retained: [] });
}, 30_000);
