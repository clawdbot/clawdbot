import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { runCodeModeWorker } from "./code-mode-worker.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  expectCodeModeSharedBudget,
  pluginTool,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";

afterEach(resetCodeModeTestState);

const cases: { input: string; base?: string; href: string; origin: string }[] = [
  {
    input: "../🦞?x=1&x=2",
    base: "https://例え.テスト/a/b",
    href: "https://xn--r8jz45g.xn--zckzah/%F0%9F%A6%9E?x=1&x=2",
    origin: "https://xn--r8jz45g.xn--zckzah",
  },
  {
    input: "http://[2001:0db8:0:0:0:0:0:1]:80/a",
    href: "http://[2001:db8::1]/a",
    origin: "http://[2001:db8::1]",
  },
  { input: "http://0x7f.1/", href: "http://127.0.0.1/", origin: "http://127.0.0.1" },
  {
    input: "%2e%2e/next",
    base: "https://example.com/a/b",
    href: "https://example.com/next",
    origin: "https://example.com",
  },
  { input: "file:///C:/a/../b", href: "file:///C:/b", origin: "null" },
  { input: "data:text/plain,hello?x#y", href: "data:text/plain,hello?x#y", origin: "null" },
  {
    input: "https://example.com:443/a b?q=a b#🦞",
    href: "https://example.com/a%20b?q=a%20b#%F0%9F%A6%9E",
    origin: "https://example.com",
  },
];

describe("Code Mode pure URL API", () => {
  it.each(cases)(
    "parses $input with WHATWG URL semantics",
    async ({ input, base, href, origin }) => {
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
      const args = [
        JSON.stringify(input),
        ...(base === undefined ? [] : [JSON.stringify(base)]),
      ].join(",");
      const result = resultDetails(
        await expectDefined(h.tools[0], "exec").execute("url", {
          code:
            "const u = new URL(" +
            args +
            "); return {href:u.href,origin:u.origin,json:JSON.stringify(u)};",
        }),
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: { href, origin, json: JSON.stringify(href) },
      });
    },
  );

  it.each([false, true])(
    "retains linked parameters and iterators across live and explicit suspension (preflight=%s)",
    async (typecheck) => {
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
      const first = resultDetails(
        await expectDefined(h.tools[0], "exec").execute("url-park", {
          language: "typescript",
          typecheck,
          code:
            'const u: URL = new URL("https://example.com/?x=1&x=2"); const p: URLSearchParams = u.searchParams; ' +
            "const entries = p.entries(); const first = entries.next().value; " +
            "await new Promise<void>(resolve => setTimeout(resolve, 0)); " +
            'json({first, same:p===u.searchParams, duplicates:p.getAll("x")}); await yield_control(); ' +
            'const second = entries.next().value; p.append("é", "a b"); const appended = u.href; ' +
            'u.search="?x=🦞&x=z"; p.delete("x", "z"); ' +
            'const record = new URLSearchParams({q:"a b"}); const iterable = new URLSearchParams([["q","a"],["q","b"]]); ' +
            'return {second,appended,same:p===u.searchParams,values:Array.from(p),record:record.toString(),iterable:iterable.getAll("q"), ' +
            'parsed:URL.parse("/ok", u)?.pathname, valid:URL.canParse("/ok",u), copied:new URL(u).href, ' +
            'network:typeof globalThis["fetch" as keyof typeof globalThis], modules:typeof globalThis["require" as keyof typeof globalThis]};',
        }),
      );
      expect(first, JSON.stringify(first)).toMatchObject({
        status: "waiting",
        output: [
          { type: "json", value: { first: ["x", "1"], same: true, duplicates: ["1", "2"] } },
        ],
      });
      const result = resultDetails(
        await expectDefined(h.tools[1], "wait").execute("url-resume", { runId: first.runId }),
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: {
          second: ["x", "2"],
          appended: "https://example.com/?x=1&x=2&%C3%A9=a+b",
          same: true,
          values: [["x", "🦞"]],
          record: "q=a+b",
          iterable: ["a", "b"],
          parsed: "/ok",
          valid: true,
          copied: "https://example.com/?x=%F0%9F%A6%9E",
          network: "undefined",
          modules: "undefined",
        },
      });
    },
  );

  it("handles coercion, stable duplicates, malformed UTF-8 and invalid inputs without host capabilities", async () => {
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
    const result = resultDetails(
      await expectDefined(h.tools[0], "exec").execute("url-errors", {
        code:
          'const p=new URLSearchParams("z=last&x=1&x=2&plus=a+b&literal=a%2Bb&bad=%FF"); p.sort(); ' +
          'const errors=[]; for (const args of [["bad"],["http://[::1"],["https://x:65536"],["/x","data:text/plain,x"]]) { try {new URL(...args);errors.push("accepted");} catch(e) {errors.push(e.name);} } ' +
          'try { new URLSearchParams([["x"]]); errors.push("accepted"); } catch(e) {errors.push(e.name);} ' +
          "const lone=new URLSearchParams({x:String.fromCharCode(0xD800)}); " +
          'return {errors,duplicates:p.getAll("x"),keys:Array.from(p.keys()),plus:p.get("plus"),literal:p.get("literal"),bad:p.get("bad"),lone:lone.toString(), ' +
          'invalid:URL.parse("bad"),canParse:URL.canParse("bad"),hasValue:p.has("x","2"),size:p.size, ' +
          'coerced:new URL({toString(){return "https://example.com/"}}).href, ' +
          "globals:[typeof fetch,typeof require,typeof process,typeof Buffer,typeof WebSocket,typeof URL.createObjectURL], " +
          'constructorEscape:URL.constructor("return typeof process")()};',
      }),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: {
        errors: Array(5).fill("TypeError"),
        duplicates: ["1", "2"],
        keys: ["bad", "literal", "plus", "x", "x", "z"],
        plus: "a b",
        literal: "a+b",
        bad: "�",
        lone: "x=%EF%BF%BD",
        invalid: null,
        canParse: false,
        hasValue: true,
        size: 6,
        coerced: "https://example.com/",
        globals: Array(6).fill("undefined"),
        constructorEscape: "undefined",
      },
    });
  });

  it("keeps colliding tools callable without replacing URL globals", async () => {
    const h = createCodeModeHarness();
    const targets = [
      pluginTool("URL", "URL fixture"),
      pluginTool("URLSearchParams", "URLSearchParams fixture"),
    ];
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
    const result = resultDetails(
      await expectDefined(h.tools[0], "exec").execute("url-collisions", {
        code: 'const calls=[]; for (const name of ["URL","URLSearchParams"]) { const handle=catalog.all().find(x=>x.toolName===name); calls.push(await handle({value:"ok"})); } return {calls,href:new URL("https://example.com").href,query:new URLSearchParams({a:"b"}).toString()};',
      }),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: {
        calls: [
          { name: "URL", input: { value: "ok" } },
          { name: "URLSearchParams", input: { value: "ok" } },
        ],
        href: "https://example.com/",
        query: "a=b",
      },
    });
    for (const target of targets) {
      expect(target.execute).toHaveBeenCalledOnce();
    }
  });

  it("keeps URL values under the existing output cap in headless execution", async () => {
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: 'const u=new URL("https://example.com/"+"é".repeat(100000)); await yield_control(); return u.href;',
      overrides: { maxOutputBytes: 1024 },
    });
    expect(result.status).toBe("completed");
    expectCodeModeSharedBudget(result, 1024);
    expect(JSON.stringify(result.value)).toContain("https://example.com/");
  });

  it.each([
    {
      name: "memory",
      source:
        'const p=new URLSearchParams(); for(let i=0;i<20000;i++)p.append("key"+i,"x".repeat(1024)); return p.size;',
      limits: { memoryLimitBytes: 8 * 1024 * 1024 },
      code: "internal_error",
    },
    {
      name: "snapshot",
      source: 'const u=new URL("https://example.com/"); await yield_control(); return u.href;',
      limits: { maxSnapshotBytes: 1024 },
      code: "snapshot_limit_exceeded",
    },
  ])("keeps URL state within the existing $name limit", async ({ name, source, limits, code }) => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, ...limits } },
    } as never);
    const result = await runCodeModeWorker(
      { kind: "exec", source, config, catalog: [], namespaces: [] },
      config.timeoutMs + 1000,
    );
    expect(result).toMatchObject({ status: "failed", code });
    if (name === "memory") {
      expect(result).toMatchObject({ error: expect.stringMatching(/memory|allocation/iu) });
    }
  });

  it("does not add network APIs to optional TypeScript preflight", async () => {
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
    const result = resultDetails(
      await expectDefined(h.tools[0], "exec").execute("url-no-fetch", {
        language: "typescript",
        typecheck: true,
        code: 'return fetch("https://example.com/");',
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("TypeScript preflight failed"),
    });
  });

  it("interrupts nonterminating URL coercion under the guest deadline", async () => {
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: "new URL({toString(){while(true){} }});",
      overrides: { timeoutMs: 500 },
      wallClockMs: 5000,
    });
    expect(result).toMatchObject({ status: "failed", code: "timeout" });
    const healthy = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: 'return new URL("https://example.com/").hostname;',
    });
    expect(healthy).toMatchObject({ status: "completed", value: "example.com" });
  });
});
