import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { codeModeRetentionEntrypoint } from "./code-mode-retention-entrypoint.test-support.js";

it("releases completed tool inputs while a real guest remains parked", async ({ signal }) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(codeModeRetentionEntrypoint)),
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
  expect(JSON.parse(result.stdout)).toEqual({
    completedInputReleased: true,
    pendingInputPreserved: true,
  });
}, 30_000);
