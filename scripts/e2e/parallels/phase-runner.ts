import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { say, warn } from "./host-command.ts";

export const PHASE_LOG_TAIL_MAX_BYTES = 512 * 1024;

function appendTextTail(current: string, chunk: string, maxBytes: number): string {
  const text = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  const combined = `${current}${text}`;
  if (Buffer.byteLength(combined) <= maxBytes) {
    return combined;
  }
  const marker = `[phase log tail truncated to last ${maxBytes} bytes]\n`;
  const tailBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const tail = Buffer.from(combined).subarray(-tailBytes).toString("utf8");
  return `${marker}${tail}`;
}

export class PhaseRunner {
  private logTail = "";
  private currentLogPath: string | undefined;
  private deadlineMs = 0;
  private timings: Array<{
    durationMs: number;
    logPath: string;
    name: string;
    status: "pass" | "fail";
    timeoutSeconds: number;
  }> = [];

  constructor(
    private runDir: string,
    private logTailMaxBytes = PHASE_LOG_TAIL_MAX_BYTES,
  ) {}

  async phase(name: string, timeoutSeconds: number, fn: () => Promise<void> | void): Promise<void> {
    const logPath = path.join(this.runDir, `${name}.log`);
    say(name);
    this.logTail = "";
    this.currentLogPath = logPath;
    this.deadlineMs = Date.now() + timeoutSeconds * 1000;
    await writeFile(logPath, "", "utf8");
    const startedAt = Date.now();
    let status: "pass" | "fail" = "fail";
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} timed out after ${timeoutSeconds}s`)),
        timeoutSeconds * 1000,
      );
    });
    try {
      await Promise.race([Promise.resolve(fn()), timeout]);
      status = "pass";
    } catch (error) {
      warn(`${name} failed`);
      warn(`log tail: ${logPath}`);
      process.stderr.write(this.logTail.split("\n").slice(-80).join("\n"));
      process.stderr.write("\n");
      throw error;
    } finally {
      this.timings.push({
        durationMs: Date.now() - startedAt,
        logPath,
        name,
        status,
        timeoutSeconds,
      });
      await this.writeTimings().catch(() => undefined);
      if (timer) {
        clearTimeout(timer);
      }
      this.currentLogPath = undefined;
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
    const line = text.endsWith("\n") ? text : `${text}\n`;
    if (this.currentLogPath) {
      appendFileSync(this.currentLogPath, line, "utf8");
    }
    this.logTail = appendTextTail(this.logTail, line, this.logTailMaxBytes);
  }

  private async writeTimings(): Promise<void> {
    const slowest = this.timings.toSorted((a, b) => b.durationMs - a.durationMs)[0] ?? null;
    await writeFile(
      path.join(this.runDir, "phase-timings.json"),
      `${JSON.stringify({ phases: this.timings, slowest }, null, 2)}\n`,
      "utf8",
    );
  }
}
