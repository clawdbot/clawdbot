import { expect, test } from "vitest";
import { deleteSession, markBackgrounded } from "./bash-process-registry.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

test("PTY cursor queries and key modes survive output chunk boundaries", async () => {
  const script = `
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let phase = 'whole';
    const received = { whole: '', split: '' };
    process.stdin.on('data', data => {
      if (phase === 'arrow') {
        console.log('ARROW=' + data.toString('hex'));
        process.exit(0);
      }
      received[phase] += data.toString('hex');
    });
    process.stdout.write('\\x1b[?1l\\x1b[6n');
    setTimeout(() => {
      console.log('WHOLE=' + received.whole);
      phase = 'split';
      process.stdout.write('\\x1b[');
      setTimeout(() => process.stdout.write('6n'), 100);
      setTimeout(() => {
        console.log('SPLIT=' + received.split);
        phase = 'arrow';
        process.stdout.write('\\x1b[?1');
        setTimeout(() => process.stdout.write('hARROW_READY\\n'), 100);
      }, 300);
    }, 300);
    setTimeout(() => process.exit(3), 5000);
  `;
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(script)}`;
  const warnings: string[] = [];
  const run = await runExecProcess({
    command,
    workdir: process.cwd(),
    env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
    usePty: true,
    warnings,
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 8,
  });
  markBackgrounded(run.session);
  try {
    await expect.poll(() => run.session.aggregated, { timeout: 5_000 }).toContain("ARROW_READY");
    await createProcessTool().execute("arrow", {
      action: "send-keys",
      sessionId: run.session.id,
      keys: ["Up"],
    });
    const outcome = await run.promise;
    expect(warnings).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.aggregated).toContain("WHOLE=1b5b313b3152");
    expect(outcome.aggregated).toContain("SPLIT=1b5b313b3152");
    expect(outcome.aggregated).toContain("ARROW=1b4f41");
  } finally {
    if (!run.session.exited) {
      run.kill();
      await run.promise;
    }
    deleteSession(run.session.id);
  }
});
