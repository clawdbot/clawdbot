import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("holds one real callback invocation and releases it once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "followup-control-test-"));
  try {
    const commandPath = path.join(root, "command.json");
    const statusPath = path.join(root, "status.json");
    const preload = fileURLToPath(new URL("./followup-drain-control-preload.mjs", import.meta.url));
    const script = `
      import fs from "node:fs";
      const commandPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
      const statusPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS;
      const write = (value) => fs.writeFileSync(commandPath, JSON.stringify(value));
      const wait = async (seq) => {
        for (let i = 0; i < 200; i += 1) {
          if (fs.existsSync(statusPath)) {
            const value = JSON.parse(fs.readFileSync(statusPath, "utf8"));
            if (value.seq === seq) return value;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("control status timeout");
      };
      const key = "agent:main:main";
      let calls = 0;
      const callbacks = new Map([[key, async () => { calls += 1; }]]);
      const run = { run: { sessionId: "session" } };
      globalThis[Symbol.for("openclaw.followupDrainCallbacks")] = callbacks;
      globalThis[Symbol.for("openclaw.followupQueues")] = new Map([[key, {
        draining: true, items: [run], inFlight: new Set([run]),
      }]]);
      write({ seq: 1, command: "arm", sessionKey: key });
      await wait(1);
      const invocation = callbacks.get(key)(run);
      write({ seq: 2, command: "waitHeld" });
      const held = await wait(2);
      if (held.inFlight !== 1 || calls !== 0) throw new Error("callback was not held");
      write({ seq: 3, command: "release" });
      await wait(3);
      await invocation;
      if (calls !== 1) throw new Error("callback did not run exactly once");
    `;
    const result = spawnSync(
      process.execPath,
      [`--import=${preload}`, "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND: commandPath,
          TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS: statusPath,
        },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
