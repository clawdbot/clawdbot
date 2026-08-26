// @vitest-environment node
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { controlUiHoverGuardPlugin } from "../../config/control-ui-hover-guard.ts";

async function transform(css: string) {
  return postcss([controlUiHoverGuardPlugin()]).process(css, { from: undefined });
}

function requireRule(node: unknown): Rule {
  expect(node).toMatchObject({ type: "rule" });
  return node as Rule;
}

function requireAtRule(node: unknown): AtRule {
  expect(node).toMatchObject({ type: "atrule" });
  return node as AtRule;
}

describe("Control UI hover guard", () => {
  it("wraps a hover rule in a hover-capable media query", async () => {
    const result = await transform(".button:hover { color: red; }");
    const guard = requireAtRule(result.root.first);

    expect(guard.params).toBe("(hover: hover)");
    expect(requireRule(guard.first).selector).toBe(".button:hover");
  });

  it("splits mixed selector lists without moving non-hover selectors", async () => {
    const result = await transform(".a:hover, .b:focus { color: red; }");
    const [original, guard] = result.root.nodes;

    expect(requireRule(original).selector).toBe(".b:focus");
    expect(requireRule(requireAtRule(guard).first).selector).toBe(".a:hover");
  });

  it("does not double-wrap an already guarded hover rule", async () => {
    const css = "@media (hover: hover) { .a:hover { color: red; } }";

    expect((await transform(css)).css).toBe(css);
  });

  it("preserves an outer media condition around the hover guard", async () => {
    const result = await transform("@media (max-width: 768px) { .a:hover { color: red; } }");
    const outer = requireAtRule(result.root.first);
    const guard = requireAtRule(outer.first);

    expect(outer.params).toBe("(max-width: 768px)");
    expect(guard.params).toBe("(hover: hover)");
    expect(requireRule(guard.first).selector).toBe(".a:hover");
  });

  it("passes CSS without hover selectors through byte-identically", async () => {
    const css = ".button:focus { color: red; }\n";

    expect((await transform(css)).css).toBe(css);
  });
});
