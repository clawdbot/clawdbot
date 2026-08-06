// Claw banner tests: static/animated gating and the final-frame invariant.
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { RuntimeEnv } from "../runtime.js";
import { printClawBanner } from "./claw-banner.js";

const runtimeStub = () => {
  const log = vi.fn();
  return { runtime: { log } as unknown as RuntimeEnv, log };
};

async function runAnimated(rng: () => number) {
  const chunks: string[] = [];
  const { runtime } = runtimeStub();
  await printClawBanner(runtime, {
    columns: 120,
    isTty: true,
    rich: true,
    env: {},
    rng,
    sleep: async () => {},
    write: (chunk) => chunks.push(chunk),
  });
  return chunks;
}

async function runStatic() {
  const { runtime, log } = runtimeStub();
  await printClawBanner(runtime, { columns: 120, isTty: false, env: {} });
  return stripAnsi(String(log.mock.calls[0]?.[0]))
    .split("\n")
    .filter((row) => row.length > 0);
}

describe("printClawBanner", () => {
  it("prints the static banner when not animatable", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 120, isTty: false, env: {} });
    const output = stripAnsi(String(log.mock.calls[0]?.[0]));
    expect(output.split("\n")[0]).toBe("▄███▄     ▄███▄");
    expect(output).toContain("█▀▀▀█ █▀▀▀█ █▀▀▀▀ █▄  █");
  });

  it("stays static under CI even on a rich TTY", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 120, isTty: true, rich: true, env: { CI: "1" } });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain title on narrow terminals", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 50, isTty: true, rich: true, env: {} });
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("OPENCLAW");
    expect(output).not.toContain("█");
  });

  it("animates on a rich TTY and settles on the exact static banner", async () => {
    const staticRows = await runStatic();
    const chunks = await runAnimated(() => 0);
    expect(chunks[0]).toBe("\x1b[?25l");
    expect(chunks).toContain("\x1b[?25h");
    const frames = chunks.filter((chunk) => chunk.includes("\x1b[K"));
    expect(frames.length).toBeGreaterThan(10);
    const finalRows = stripAnsi(frames[frames.length - 1] ?? "")
      .split("\n")
      .filter((row) => row.length > 0);
    expect(finalRows).toEqual(staticRows);
  });

  it("installs scoped signal handlers only while animating", async () => {
    const before = process.listenerCount("SIGINT");
    let during = -1;
    const { runtime } = runtimeStub();
    await printClawBanner(runtime, {
      columns: 120,
      isTty: true,
      rich: true,
      env: {},
      rng: () => 0.99,
      sleep: async () => {
        during = Math.max(during, process.listenerCount("SIGINT"));
      },
      write: () => {},
    });
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("settles on the static frame when parallel work finishes first", async () => {
    const staticRows = await runStatic();
    const chunks: string[] = [];
    const beforeSigint = process.listenerCount("SIGINT");
    let settle!: () => void;
    const settleWhen = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { runtime } = runtimeStub();
    const banner = printClawBanner(runtime, {
      columns: 120,
      isTty: true,
      rich: true,
      env: {},
      rng: () => 0.99,
      settleWhen,
      sleep: () => new Promise<void>(() => {}),
      write: (chunk) => chunks.push(chunk),
    });

    expect(chunks[0]).toBe("\x1b[?25l");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    settle();
    await expect(banner).resolves.toBe("settled");

    const frames = chunks.filter((chunk) => chunk.includes("\x1b[K"));
    const finalRows = stripAnsi(frames.at(-1) ?? "")
      .split("\n")
      .filter((row) => row.length > 0);
    expect(finalRows).toEqual(staticRows);
    expect(chunks.at(-2)).toBe("\x1b[?25h");
    expect(chunks.at(-1)).toBe("\n");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
  });

  it("varies snips and shimmer passes with the rng", async () => {
    // rng below the thresholds adds a second shimmer pass and a second snip.
    const maximal = (await runAnimated(() => 0)).filter((c) => c.includes("\x1b[K"));
    const minimal = (await runAnimated(() => 0.99)).filter((c) => c.includes("\x1b[K"));
    expect(maximal.length).toBeGreaterThan(minimal.length);
  });
});
