import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../jsonc/parse.js";
import { resolveJsoncOcPath } from "../../jsonc/resolve.js";
import { parseOcPath } from "../../oc-path.js";

function rs(raw: string, ocPath: string) {
  return resolveJsoncOcPath(parseJsonc(raw).ast, parseOcPath(ocPath));
}

describe("jsonc resolver edges", () => {
  it("root resolves on empty object", () => {
    expect(rs("{}", "oc://config")?.kind).toBe("root");
  });

  it("root resolves on scalar root", () => {
    expect(rs("42", "oc://config")?.kind).toBe("root");
  });

  it("root resolves on array root", () => {
    expect(rs("[1,2,3]", "oc://config")?.kind).toBe("root");
  });

  it("deep dotted descent within section", () => {
    const m = rs('{"a":{"b":{"c":1}}}', "oc://config/a.b.c");
    expect(m?.kind).toBe("object-entry");
  });

  it("missing intermediate key returns null", () => {
    expect(rs('{"a":{"b":1}}', "oc://config/a.x.b")).toBeNull();
  });

  it("numeric segment indexes into array", () => {
    const m = rs('{"items":["a","b","c"]}', "oc://config/items.1");
    expect(m?.kind).toBe("value");
    if (m?.kind === "value") {
      expect(m.node.kind).toBe("string");
      if (m.node.kind === "string") {
        expect(m.node.value).toBe("b");
      }
    }
  });

  it("out-of-bounds array index returns null", () => {
    expect(rs('{"x":[1,2]}', "oc://config/x.99")).toBeNull();
  });

  it("non-integer index returns null (no NaN coercion)", () => {
    expect(rs('{"x":[1,2]}', "oc://config/x.foo")).toBeNull();
  });

  it("null AST root returns null on any path", () => {
    expect(rs("", "oc://config/x")).toBeNull();
  });

  it("descending past a primitive returns null", () => {
    expect(rs('{"x":42}', "oc://config/x.y")).toBeNull();
  });

  it("empty segment in dotted path throws OcPathError", () => {
    // v1 invariant: malformed paths fail loud at parse time, not silently null.
    expect(() => rs('{"x":1}', "oc://config/x..y")).toThrow(/Empty dotted sub-segment/);
  });

  it("string value at leaf surfaces via object-entry shape", () => {
    const m = rs('{"k":"v"}', "oc://config/k");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.key).toBe("k");
    }
  });

  it("boolean and null values resolve", () => {
    const m1 = rs('{"k":true}', "oc://config/k");
    expect(m1?.kind).toBe("object-entry");
    const m2 = rs('{"k":null}', "oc://config/k");
    expect(m2?.kind).toBe("object-entry");
  });

  it("mixed slash + dot segments resolve identically", () => {
    const a = rs('{"a":{"b":{"c":1}}}', "oc://config/a.b.c");
    const b = rs('{"a":{"b":{"c":1}}}', "oc://config/a/b.c");
    const c = rs('{"a":{"b":{"c":1}}}', "oc://config/a/b/c");
    expect(a?.kind).toBe(b?.kind);
    expect(b?.kind).toBe(c?.kind);
  });

  it("keys with special characters resolve", () => {
    const m = rs('{"a-b_c":{"x":1}}', "oc://config/a-b_c.x");
    expect(m?.kind).toBe("object-entry");
  });

  it("unicode keys resolve", () => {
    const m = rs('{"héllo":1}', "oc://config/héllo");
    expect(m?.kind).toBe("object-entry");
  });

  it("large nested structure (depth 20) resolves to leaf", () => {
    let json = '"leaf"';
    const segs: string[] = [];
    for (let i = 19; i >= 0; i--) {
      json = `{"k${i}":${json}}`;
      segs.unshift(`k${i}`);
    }
    const m = rs(json, `oc://config/${segs.join(".")}`);
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.value.kind).toBe("string");
      if (m.node.value.kind === "string") {
        expect(m.node.value.value).toBe("leaf");
      }
    }
  });

  it("resolver is non-mutating across calls", () => {
    const { ast } = parseJsonc('{"x":{"y":1}}');
    const before = JSON.stringify(ast);
    rs('{"x":{"y":1}}', "oc://config/x.y");
    rs('{"x":{"y":1}}', "oc://config/x");
    rs('{"x":{"y":1}}', "oc://config/missing");
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("hostile input shapes do not throw", () => {
    expect(() => rs("{garbage}", "oc://config/x")).not.toThrow();
    expect(() => rs('{"a":', "oc://config/a")).not.toThrow();
  });
});
