import { writeFile } from "node:fs/promises";
import path from "node:path";
import { say, warn } from "./host-command.ts";

export class PhaseRunner {
  private logText = "";
  private deadlineMs = 0;

  constructor(private runDir: string) {}

  async phase(name: string, timeoutSeconds: number, fn: () => Promise<void> | void): Promise<void> {
    const logPath = path.join(this.runDir, `${name}.log`);
    say(name);
    this.logText = "";
    this.deadlineMs = Date.now() + timeoutSeconds * 1000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} timed out after ${timeoutSeconds}s`)),
        timeoutSeconds * 1000,
      );
    });
    try {
      await Promise.race([Promise.resolve(fn()), timeout]);
      await writeFile(logPath, this.logText, "utf8");
    } catch (error) {
      await writeFile(logPath, this.logText, "utf8").catch(() => undefined);
      warn(`${name} failed`);
      warn(`log tail: ${logPath}`);
      process.stderr.write(this.logText.split("\n").slice(-80).join("\n"));
      process.stderr.write("\n");
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      this.deadlineMs = 0;
    }
  }

  async phaseReturns(
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<boolean> {
    try {
      await this.phase(name, timeoutSeconds, fn);
      return true;
    } catch {
      return false;
    }
  }

  remainingTimeoutMs(fallbackMs?: number): number | undefined {
    if (this.deadlineMs === 0) {
      return fallbackMs;
    }
    const remaining = this.deadlineMs - Date.now();
    if (remaining <= 0) {
      throw new Error("phase deadline exceeded before starting guest command");
    }
    return Math.max(1_000, fallbackMs == null ? remaining : Math.min(remaining, fallbackMs));
  }

  append(text: string): void {
    if (!text) {
      return;
    }
    this.logText += text;
    if (!text.endsWith("\n")) {
      this.logText += "\n";
    }
  }
}
