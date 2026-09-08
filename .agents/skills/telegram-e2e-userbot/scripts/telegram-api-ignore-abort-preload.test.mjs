import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("suppresses only the selected Telegram request timeout", () => {
  const preload = fileURLToPath(
    new URL("./telegram-api-ignore-abort-preload.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      `--import=${preload}`,
      "--input-type=module",
      "--eval",
      `const held = new AbortController();
held.abort(new Error("Telegram sendmessage timed out after 60000ms"));
if (held.signal.aborted) throw new Error("selected timeout was not suppressed");
const other = new AbortController();
other.abort(new Error("shutdown"));
if (!other.signal.aborted) throw new Error("unrelated abort was suppressed");`,
    ],
    {
      env: { ...process.env, TELEGRAM_E2E_IGNORE_ABORT_METHODS: '["sendMessage"]' },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
