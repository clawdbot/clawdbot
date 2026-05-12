import { describe, expect, it } from "vitest";
import { findOcPaths } from "../../find.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";
import { resolveOcPath } from "../../universal.js";

const log = `{"event":"start","ts":1}
{"event":"step","n":1,"result":{"ok":true,"detail":"a"}}

{"event":"end","ts":99}
`;

function rs(ocPath: string) {
  const { ast } = parseJsonl(log);
  return resolveJsonlOcPath(ast, parseOcPath(ocPath));
}

describe("resolveJsonlOcPath", () => {
  it("returns root when no segments are given", () => {
    expect(rs("oc://session-events")?.kind).toBe("root");
  });

  it("addresses an entire line by line number", () => {
    const m = rs("oc://session-events/L1");
    expect(m?.kind).toBe("line");
  });

  it("addresses fields under a line via item segment", () => {
    const m = rs("oc://session-events/L2/event");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.value.kind).toBe("string");
      if (m.node.value.kind === "string") {
        expect(m.node.value.value).toBe("step");
      }
    }
  });

  it("descends via dotted item paths", () => {
    const m = rs("oc://session-events/L2/result.ok");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.value.kind).toBe("boolean");
      if (m.node.value.kind === "boolean") {
        expect(m.node.value.value).toBe(true);
      }
    }
  });

  it("resolves $last to the most recent value line", () => {
    const m = rs("oc://session-events/$last/event");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expect(m.node.value.kind).toBe("string");
      if (m.node.value.kind === "string") {
        expect(m.node.value.value).toBe("end");
      }
    }
  });

  it("returns null for unknown line addresses", () => {
    expect(rs("oc://session-events/L99")).toBeNull();
    expect(rs("oc://session-events/garbage")).toBeNull();
  });

  it("returns null when descending into a blank line", () => {
    expect(rs("oc://session-events/L3/anything")).toBeNull();
  });
});

describe("resolveJsonlToUniversal — file-relative line metadata (regression)", () => {
  // Regression: surfaced via the openclaw-path CLI scenario run on
  // a multi-line session.jsonl. Every match returned `line: 1`
  // because the inside-line jsonc parser numbers from 1 within each
  // line's bytes; the universal resolve was preferring that local
  // number over the JsonlLine's file-relative line.

  const log = [
    '{"event":"start"}', // line 1
    '{"event":"step","n":1}', // line 2
    '{"event":"step","n":2}', // line 3
    '{"event":"end"}', // line 4
    "", // line 5 (blank)
  ].join("\n");

  it("resolves L2/event with line=2 (not 1)", () => {
    const { ast } = parseJsonl(log);
    const m = resolveOcPath(ast, parseOcPath("oc://session.jsonl/L2/event"));
    if (m === null) {
      throw new Error("expected L2/event match");
    }
    expect(m.line).toBe(2);
  });

  it("resolves L4/event with line=4", () => {
    const { ast } = parseJsonl(log);
    const m = resolveOcPath(ast, parseOcPath("oc://session.jsonl/L4/event"));
    if (m === null) {
      throw new Error("expected L4/event match");
    }
    expect(m.line).toBe(4);
  });

  it("findOcPaths over wildcard surfaces correct file-relative lines", () => {
    const { ast } = parseJsonl(log);
    const matches = findOcPaths(ast, parseOcPath("oc://session.jsonl/*/event"));
    expect(matches).toHaveLength(4);
    const lines = matches.map((m) => m.match.line);
    expect(lines).toEqual([1, 2, 3, 4]);
  });
});
