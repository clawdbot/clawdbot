import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../jsonc/parse.js";
import { resolveJsoncOcPath } from "../../jsonc/resolve.js";
import { parseOcPath } from "../../oc-path.js";

function rs(raw: string, ocPath: string) {
  const { ast } = parseJsonc(raw);
  const path = parseOcPath(ocPath);
  return resolveJsoncOcPath(ast, path);
}

describe("resolveJsoncOcPath", () => {
  const config = `{
  "plugins": {
    "entries": {
      "github": {
        "token": "secret",
        "enabled": true
      }
    }
  },
  "limits": [10, 20, 30]
}`;

  it("resolves the root when no segments are given", () => {
    const m = rs(config, "oc://config");
    expect(m?.kind).toBe("root");
  });

  it("walks dotted section paths", () => {
    const m = rs(config, "oc://config/plugins.entries.github.token");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.key).toBe("token");
      expect(m.node.value.kind).toBe("string");
      if (m.node.value.kind === "string") {
        expect(m.node.value.value).toBe("secret");
      }
    }
  });

  it("walks 4-segment slash paths up to OcPath depth limit", () => {
    const m = rs(config, "oc://config/plugins/entries/github");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.key).toBe("github");
    }
  });

  it("walks mixed dotted+slash paths", () => {
    const m = rs(config, "oc://config/plugins/entries.github.token");
    expect(m?.kind).toBe("object-entry");
  });

  it("indexes into arrays via numeric segments", () => {
    const m = rs(config, "oc://config/limits.1");
    expect(m?.kind).toBe("value");
    if (m?.kind === "value") {
      expect(m.node.kind).toBe("number");
      if (m.node.kind === "number") {
        expect(m.node.value).toBe(20);
      }
    }
  });

  it("returns null for missing keys", () => {
    expect(rs(config, "oc://config/plugins.entries.gitlab")).toBeNull();
  });

  it("returns null for out-of-bounds array indexes", () => {
    expect(rs(config, "oc://config/limits.99")).toBeNull();
  });

  it("returns null when descending past a primitive", () => {
    expect(rs(config, "oc://config/plugins.entries.github.token.x")).toBeNull();
  });

  it("returns null on empty AST", () => {
    const { ast } = parseJsonc("");
    expect(resolveJsoncOcPath(ast, parseOcPath("oc://config/x"))).toBeNull();
  });
});
