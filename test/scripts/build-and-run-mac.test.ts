import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/build-and-run-mac.sh";

describe("scripts/build-and-run-mac.sh", () => {
  it("keeps launch logs isolated unless an explicit log path is provided", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_MAC_RUN_LOG:-$(mktemp "${TMPDIR:-/tmp}/openclaw-${PRODUCT}.XXXXXX.log")}"',
    );
    expect(script).toContain('nohup "$BIN" >"$LOG_PATH" 2>&1 &');
    expect(script).toContain('printf "Started $PRODUCT (PID $PID). Logs: $LOG_PATH\\n"');
    expect(script).not.toContain("/tmp/openclaw.log");
  });
});
