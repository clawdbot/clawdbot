import { expect, it } from "vitest";
import {
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

it("keeps the terminal responsive after a cold non-auth provider failure", async () => {
  const fixture = await startTuiFixture();
  try {
    await fixture.run.waitForOutput("local ready", 20_000);
    await fixture.run.write("provider failure proof\r", { delay: false });
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("run error: fixture provider failed")),
      2_000,
    );
    expect(rows.join("\n")).not.toContain("/auth");
    await fixture.run.write("/session recovered\r", { delay: false });
    await fixture.run.waitForOutput("session agent:main:recovered");
  } finally {
    await fixture.cleanup();
  }
}, 25_000);
