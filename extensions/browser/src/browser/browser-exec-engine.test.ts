import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_EXEC_OUTPUT_MAX_CHARS,
  executeBrowserScript,
  type BrowserExecHost,
} from "./browser-exec-engine.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("browser exec worker engine", () => {
  it("runs helper RPCs and returns JSON values with captured logs", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const host: BrowserExecHost = async ({ method, params }) => {
      calls.push({ method, params });
      return { method, params };
    };

    const result = await executeBrowserScript({
      code: `
        const click = await act({ kind: "click", ref: "e1" });
        const page = await snapshot({ mode: "efficient" });
        const navigation = await open("data:text/html,ok");
        const listed = await tabs();
        await log("visited", navigation.method, { count: listed.params.length });
        return { click, page };
      `,
      host,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        click: { method: "act", params: [{ kind: "click", ref: "e1" }] },
        page: { method: "snapshot", params: [{ mode: "efficient" }] },
      },
      logs: ['visited open {"count":0}'],
    });
    expect(calls).toEqual([
      { method: "act", params: [{ kind: "click", ref: "e1" }] },
      { method: "snapshot", params: [{ mode: "efficient" }] },
      { method: "open", params: ["data:text/html,ok"] },
      { method: "tabs", params: [] },
    ]);
  });

  it("caps combined return values and logs", async () => {
    const result = await executeBrowserScript({
      code: `
        await log("l".repeat(100_000));
        return { value: "v".repeat(100_000) };
      `,
      host: async () => null,
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.ok ? result.value : null).length).toBeLessThanOrEqual(
      BROWSER_EXEC_OUTPUT_MAX_CHARS,
    );
    expect(result.logs).toEqual([]);
    expect(result.ok ? String(result.value) : "").toContain("[truncated]");

    const logsOnly = await executeBrowserScript({
      code: `
        await log('"'.repeat(100_000));
        return null;
      `,
      host: async () => null,
    });
    expect(logsOnly.ok).toBe(true);
    expect(
      JSON.stringify(logsOnly.ok ? logsOnly.value : null).length +
        JSON.stringify(logsOnly.logs).length,
    ).toBeLessThanOrEqual(BROWSER_EXEC_OUTPUT_MAX_CHARS);
    expect(logsOnly.logs.at(-1)).toContain("[truncated]");
  });

  it("terminates an infinite loop and keeps later executions healthy", async () => {
    vi.useFakeTimers();
    const pending = executeBrowserScript({
      code: "while (true) {}",
      timeoutMs: 5_000,
      host: async () => null,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const timedOut = await pending;
    vi.useRealTimers();

    expect(timedOut).toMatchObject({
      ok: false,
      timedOut: true,
      error: { name: "TimeoutError" },
    });
    await expect(
      executeBrowserScript({ code: "return 42", host: async () => null }),
    ).resolves.toEqual({ ok: true, value: 42, logs: [] });
  });

  it("returns thrown script errors without rejecting the host promise", async () => {
    await expect(
      executeBrowserScript({
        code: 'throw new TypeError("broken script")',
        host: async () => null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      logs: [],
      error: {
        name: "TypeError",
        message: expect.stringContaining("broken script"),
      },
    });
  });
});
