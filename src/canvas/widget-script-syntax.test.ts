import { describe, expect, it } from "vitest";
import { findWidgetScriptSyntaxError } from "./widget-script-syntax.js";

describe("widget script syntax", () => {
  it("maps a raw newline in a single-quoted string to the original widget line", () => {
    const widgetCode = "\n<section>\n  <script>const a='x\n'+b;</script>\n</section>";
    expect(findWidgetScriptSyntaxError(widgetCode)).toEqual({
      message: "Unterminated string constant",
      line: 3,
      column: 18,
      snippet: "<script>const a='x",
      scriptIndex: 1,
    });
  });

  it.each([
    "<p>No scripts</p>",
    '<script>const html = "<!--<script></script>-->";</script>',
    '<script>a = "<!--"; </script>',
    '<script>const html = "<!--<script></script>";</script>',
    '<script>const html = "<!--<script>-->";</script>',
    '<script>const html = "<!--<ScRiPt/></SCRIPT>-->";</script>',
    '<script type="&#109;odule">await Promise.resolve();</script>',
    "<script>#!/usr/bin/env node\nconst a=1;</script>",
    "<script>const value = 1;",
    '<script>const value = "</scripture>";</script>',
    "<script-example>const =</script-example>",
    "1 < 2 <script>const value = 1;</script>",
    "<!doctype html><script>const value = 1;</script>",
    "<script>const a='x\\n'; document.body.textContent = a;</script>",
    '<script type="module">const value = await Promise.resolve(1); export { value };</script>',
    '<script type=" Text/JavaScript ">const value = 1;</script>',
    '<script data-label="src=ignored > type=application/json">const value = 1;</SCRIPT>',
    '<button onclick="const =">Handlers are not parsed</button>',
  ])("accepts valid scripts or markup: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each([
    "",
    "type",
    'type=""',
    "type='text/javascript'",
    "type=application/javascript",
    'TYPE=" TEXT/ECMASCRIPT "',
    "type=application/ecmascript",
    "type=application/x-javascript",
    "type=text/jscript",
    "type=text/javascript1.5",
    "type=text/livescript",
  ])("rejects top-level await in classic scripts: %s", (attributes) => {
    expect(
      findWidgetScriptSyntaxError(`<script ${attributes}>await Promise.resolve();</script>`),
    ).toMatchObject({ scriptIndex: 1 });
  });

  it("does not allow wrapped-function grammar", () => {
    expect(findWidgetScriptSyntaxError("<script>return 1;</script>")).toBeDefined();
  });

  it.each([
    'type="application/json"',
    "type='application/ld+json'",
    "type=importmap",
    "type=text/template",
    "type=text/x-handlebars-template",
    'src="script.js"',
    "src='script.js'",
    "SRC=script.js",
    "src",
  ])("skips non-JavaScript and external scripts: %s", (attributes) => {
    expect(findWidgetScriptSyntaxError(`<script ${attributes}>const =</script>`)).toBeUndefined();
  });

  it.each(["<script>const a = 1;</script>", '<script type="application/json">invalid JS</script>'])(
    "maps the second script after %s and stops at a case-insensitive raw-text close",
    (first) => {
      const widgetCode = `${first}\r\n<p>Text</p>\r\n<script>const a = "</SCRIPT>";</script>`;
      expect(findWidgetScriptSyntaxError(widgetCode)).toEqual({
        message: "Unterminated string constant",
        line: 3,
        column: 18,
        snippet: '<script>const a = "</SCRIPT>";</script>',
        scriptIndex: 2,
      });
    },
  );

  it("reports only the first error across multiple scripts", () => {
    expect(
      findWidgetScriptSyntaxError("<script>const =</script><script>let =</script>"),
    ).toMatchObject({ scriptIndex: 1, line: 1, column: 14 });
  });

  it.each([
    "<!-- <script>const =</script> -->",
    "<!-- <script>const =</script>",
    '<div title="<script>const =</script>">Text</div>',
    "<div title='<script>const =</script>'>Text</div>",
    "<textarea><script>const =</script></textarea>",
    "<plaintext></plaintext><script>const =</script>",
    '<div title="<script>const =</script>',
  ])("ignores script-looking text outside script elements: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"])(
    "skips %s content and resumes at its actual end tag",
    (tag) => {
      const prefix = `<${tag}>ignored </${tag}x><script>const =</script></${tag.toUpperCase()} >`;
      expect(findWidgetScriptSyntaxError(prefix)).toBeUndefined();
      expect(findWidgetScriptSyntaxError(`${prefix}\n<script>const =</script>`)).toMatchObject({
        scriptIndex: 1,
        line: 2,
        column: 14,
      });
      expect(findWidgetScriptSyntaxError(`<${tag}><script>const =</script>`)).toBeUndefined();
    },
  );

  it("preserves offsets and script indexes after skipping inert HTML contexts", () => {
    const widgetCode = [
      "<!-- <script>const =</script> -->",
      "<textarea><script>const =</script></textarea>",
      '<div title="İ <script>const =</script>"></div>',
      "  <script>const =</script>",
    ].join("\n");
    expect(findWidgetScriptSyntaxError(widgetCode)).toEqual({
      message: "Unexpected token",
      scriptIndex: 1,
      line: 4,
      column: 16,
      snippet: "<script>const =</script>",
    });
  });

  it.each(["</script/>", '</script foo="bar">', "</SCRIPT >", ""])(
    "parses the script body through its terminator or EOF: %s",
    (endTag) => {
      expect(findWidgetScriptSyntaxError(`<script>const =${endTag}`)).toMatchObject({
        scriptIndex: 1,
        line: 1,
        column: 14,
      });
      expect(findWidgetScriptSyntaxError(`<script>const value = 1;${endTag}`)).toBeUndefined();
      if (endTag) {
        expect(
          findWidgetScriptSyntaxError(
            `<script>const value = 1;${endTag}\n<script>const =</script>`,
          ),
        ).toMatchObject({ scriptIndex: 2, line: 2, column: 14 });
      }
    },
  );

  it.each([
    '<script>const html = "<script></script>";</script>',
    '<script>const html = "<!--<scripture></script>";</script>',
  ])("ends script data unless the exact script token double-escapes it: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)?.message).toBe("Unterminated string constant");
  });

  it.each([
    "<svg><script><![CDATA[const value = 1;]]></script></svg>",
    "<svg><svg></svg><script><![CDATA[const value = 1;]]></script></svg>",
    "<svg><svg/><script><![CDATA[const value = 1;]]></script></svg>",
    '<svg><script><![CDATA[const text = "</script>";]]></script></svg>',
    "<svg><title/><style/><script><![CDATA[const value = 1;]]></script></svg>",
    "<div><svg><text><![CDATA[Example: > <script>const =</script>]]></text></svg></div>",
    '<div><svg><foreignObject><script>const text = "<![CDATA[";</script></foreignObject></svg></div>',
    "<svg><foreignObject/><script><![CDATA[const value = 1;]]></script></svg>",
    '<SVG xmlns="http://www.w3.org/2000/svg"><script> \n<![CDATA[const value = 1;]]> \n</script></SVG>',
  ])("parses CDATA-wrapped scripts in SVG: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toBeUndefined();
  });

  it.each([
    {
      widgetCode: "<svg><script><![CDATA[const =]]></script></svg>",
      line: 1,
      column: 28,
      snippet: "<svg><script><![CDATA[const =]]></script></svg>",
    },
    {
      widgetCode: "<svg>\n  <script>  <![CDATA[const =]]> </script>\n</svg>",
      line: 2,
      column: 27,
      snippet: "<script>  <![CDATA[const =]]> </script>",
    },
    {
      widgetCode: "<svg>\r\n<script>\n<![CDATA[\nconst =\n]]>\n</script></svg>",
      line: 4,
      column: 6,
      snippet: "const =",
    },
  ])(
    "maps CDATA errors to the original widget: $widgetCode",
    ({ widgetCode, line, column, snippet }) => {
      expect(findWidgetScriptSyntaxError(widgetCode)).toEqual({
        message: "Unexpected token",
        scriptIndex: 1,
        line,
        column,
        snippet,
      });
    },
  );

  it.each([
    "<svg><title/></svg><script>const =</script>",
    "<svg><style/><script>const =</script></svg>",
    '<svg><script><![CDATA[const text = "</script>";]]></script></svg><script>const =</script>',
    "<svg><text><![CDATA[text]]></text></svg><script>const =</script>",
    "<svg><foreignObject><script>const =</script></foreignObject></svg>",
    "<svg><foreignObject><script><![CDATA[const value = 1;]]></script></foreignObject></svg>",
  ])("still reaches scripts after self-closing or CDATA foreign content: %s", (widgetCode) => {
    expect(findWidgetScriptSyntaxError(widgetCode)).toMatchObject({ line: 1 });
  });

  it.each(["", "<svg/>", "<svg></svg>", "<svg><svg/></svg>"])(
    "leaves CDATA markers outside SVG untouched after %s",
    (prefix) => {
      expect(
        findWidgetScriptSyntaxError(`${prefix}<script><![CDATA[const value = 1;]]></script>`),
      ).toMatchObject({ message: "Unexpected token", scriptIndex: 1 });
    },
  );

  it.each(["text&#47;javascript", "text&sol;javascript", "&#109;odule"])(
    "validates scripts whose type contains character references: %s",
    (type) => {
      expect(findWidgetScriptSyntaxError(`<script type="${type}">const =</script>`)).toMatchObject({
        message: "Unexpected token",
        scriptIndex: 1,
      });
    },
  );

  it("bounds the offending line snippet", () => {
    const widgetCode = `<script>const = ${"x".repeat(1_000)}</script>`;
    expect(findWidgetScriptSyntaxError(widgetCode)?.snippet).toBe(widgetCode.slice(0, 160));
  });
});
