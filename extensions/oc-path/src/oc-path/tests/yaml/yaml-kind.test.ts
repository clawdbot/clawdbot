import { describe, expect, it } from "vitest";
import { inferKind } from "../../dispatch.js";
import { parseOcPath } from "../../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../../sentinel.js";
import { resolveOcPath, setOcPath } from "../../universal.js";
import { insertYamlOcPath, setYamlOcPath } from "../../yaml/edit.js";
import { emitYaml } from "../../yaml/emit.js";
import { parseYaml } from "../../yaml/parse.js";
import { resolveYamlOcPath } from "../../yaml/resolve.js";

const LOBSTER = `name: inbox-triage
description: A simple example workflow

steps:
  - id: fetch
    command: gog.gmail.search --query 'newer_than:1d' --max 20

  - id: classify
    command: openclaw.invoke --tool llm-task --action json
    stdin: $fetch.stdout
`;

describe("parseYaml — round-trip", () => {
  it("preserves bytes verbatim on round-trip", () => {
    const { ast } = parseYaml(LOBSTER);
    expect(emitYaml(ast)).toBe(LOBSTER);
  });

  it("exposes kind: yaml discriminator", () => {
    const { ast } = parseYaml(LOBSTER);
    expect(ast.kind).toBe("yaml");
  });

  it("handles empty file", () => {
    const { ast } = parseYaml("");
    expect(ast.kind).toBe("yaml");
    expect(emitYaml(ast)).toBe("");
  });

  it("reports errors as diagnostics, not throws", () => {
    const { diagnostics } = parseYaml("key: value\n  bad indent: oops\n");
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

describe("resolveYamlOcPath — direct", () => {
  it("resolves top-level scalar", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveYamlOcPath(ast, parseOcPath("oc://workflow.lobster/name"));
    expect(m?.kind).toBe("pair");
    if (m?.kind === "pair") {
      expect(m.value).toBe("inbox-triage");
    }
  });

  it("resolves into a sequence by index", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveYamlOcPath(ast, parseOcPath("oc://workflow.lobster/steps.0.id"));
    expect(m?.kind).toBe("pair");
    if (m?.kind === "pair") {
      expect(m.value).toBe("fetch");
    }
  });

  it("returns root when no segments", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveYamlOcPath(ast, parseOcPath("oc://workflow.lobster"));
    expect(m?.kind).toBe("root");
  });

  it("returns null for unresolved paths", () => {
    const { ast } = parseYaml(LOBSTER);
    expect(resolveYamlOcPath(ast, parseOcPath("oc://workflow.lobster/missing"))).toBeNull();
  });
});

describe("setYamlOcPath — direct", () => {
  it("replaces a scalar value", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(ast, parseOcPath("oc://workflow.lobster/name"), "new-name");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("name: new-name");
    }
  });

  it("replaces a nested scalar", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(ast, parseOcPath("oc://workflow.lobster/steps.0.id"), "fetch-renamed");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("id: fetch-renamed");
    }
  });

  it("returns unresolved for missing path", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(ast, parseOcPath("oc://workflow.lobster/missing"), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });

  it("returns parse-error before editing a malformed document", () => {
    const { ast } = parseYaml("key: value\n  bad indent: oops\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://workflow.yaml/key"), "new-value");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("returns parse-error before inserting into a malformed document", () => {
    const { ast } = parseYaml("key: value\n  bad indent: oops\n");
    const r = insertYamlOcPath(
      ast,
      parseOcPath("oc://workflow.yaml"),
      { kind: "keyed", key: "next" },
      "x",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});

describe("setYamlOcPath — positional tokens", () => {
  it("edits the first seq element via $first", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(
      ast,
      parseOcPath("oc://workflow.lobster/steps/$first/id"),
      "fetch-renamed",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("id: fetch-renamed");
    }
  });

  it("edits the last seq element via $last", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setYamlOcPath(
      ast,
      parseOcPath("oc://workflow.lobster/steps/$last/id"),
      "classify-renamed",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("id: classify-renamed");
    }
  });

  it("edits the first map entry via $first", () => {
    const { ast } = parseYaml("config:\n  a: 1\n  b: 2\n  c: 3\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/config/$first"), 99);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("a: 99");
    }
  });

  it("edits the last map entry via $last", () => {
    const { ast } = parseYaml("config:\n  a: 1\n  b: 2\n  c: 3\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/config/$last"), 99);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain("c: 99");
    }
  });

  it("returns unresolved for $last against an empty seq", () => {
    const { ast } = parseYaml("items: []\n");
    const r = setYamlOcPath(ast, parseOcPath("oc://x.yaml/items/$last"), "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });
});

describe("inferKind — yaml extensions", () => {
  it("maps .yaml / .yml / .lobster to yaml", () => {
    expect(inferKind("workflow.yaml")).toBe("yaml");
    expect(inferKind("config.yml")).toBe("yaml");
    expect(inferKind("inbox-triage.lobster")).toBe("yaml");
  });
});

describe("universal verbs — yaml dispatch", () => {
  it("resolveOcPath returns kind-agnostic match for yaml leaf", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.lobster/name"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "inbox-triage", leafType: "string" });
  });

  it("resolveOcPath returns node:yaml-map for top-level seq item", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.lobster/steps.0"));
    expect(m).toMatchObject({ kind: "node", descriptor: "yaml-map" });
  });

  it("resolveOcPath returns node:yaml-seq for sequence root", () => {
    const { ast } = parseYaml(LOBSTER);
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.lobster/steps"));
    expect(m).toMatchObject({ kind: "node", descriptor: "yaml-seq" });
  });

  it("resolveOcPath returns yaml-map insertion for map root", () => {
    const { ast } = parseYaml("name: inbox\n");
    const m = resolveOcPath(ast, parseOcPath("oc://workflow.yaml/+owner"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "yaml-map" });
  });

  it("resolveOcPath returns yaml-seq insertion for sequence root", () => {
    const { ast } = parseYaml("- a\n");
    const m = resolveOcPath(ast, parseOcPath("oc://items.yaml/+"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "yaml-seq" });
  });

  it("resolveOcPath rejects insertion under scalar root", () => {
    const { ast } = parseYaml("hello\n");
    const m = resolveOcPath(ast, parseOcPath("oc://value.yaml/+"));
    expect(m).toBeNull();
  });

  it("setOcPath replaces a yaml scalar via universal verb", () => {
    const { ast } = parseYaml(LOBSTER);
    const r = setOcPath(ast, parseOcPath("oc://workflow.lobster/name"), "updated");
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("name: updated");
    }
  });

  it("setOcPath coerces numeric string to number for number leaf", () => {
    const { ast } = parseYaml("count: 5\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/count"), "42");
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("count: 42");
    }
  });

  it("setOcPath returns parse-error for invalid coercion", () => {
    const { ast } = parseYaml("count: 5\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/count"), "abc");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});

describe("universal verbs — yaml insertion", () => {
  it("appends to a yaml seq with `+`", () => {
    const { ast } = parseYaml("items:\n  - a\n  - b\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), '"c"');
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("- c");
    }
  });

  it("appends to an empty yaml seq with `+`", () => {
    const { ast } = parseYaml("items: []\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), '"a"');
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("items: [ a ]");
    }
  });

  it("adds key to yaml map with `+key`", () => {
    const { ast } = parseYaml("config:\n  a: 1\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/config/+b"), "2");
    expect(r.ok).toBe(true);
    if (r.ok && r.ast.kind === "yaml") {
      expect(r.ast.raw).toContain("b: 2");
    }
  });

  it("rejects duplicate map key on insertion", () => {
    const { ast } = parseYaml("config:\n  a: 1\n");
    const r = setOcPath(ast, parseOcPath("oc://x.yaml/config/+a"), "99");
    expect(r.ok).toBe(false);
  });

  it("rejects sentinel-bearing yaml replacements before raw emit", () => {
    const { ast } = parseYaml("token: safe\n");
    expect(() => setOcPath(ast, parseOcPath("oc://x.yaml/token"), REDACTED_SENTINEL)).toThrow(
      OcEmitSentinelError,
    );
  });

  it("rejects sentinel-bearing yaml insertions before raw emit", () => {
    const { ast } = parseYaml("items: []\n");
    expect(() =>
      setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), `{"token":"${REDACTED_SENTINEL}"}`),
    ).toThrow(OcEmitSentinelError);
  });

  it("rejects sentinel-bearing yaml insertion keys before raw emit", () => {
    const { ast } = parseYaml("config:\n  safe: 1\n");
    expect(() =>
      setOcPath(ast, parseOcPath(`oc://x.yaml/config/+${REDACTED_SENTINEL}`), "2"),
    ).toThrow(OcEmitSentinelError);
  });

  it("rejects sentinel-bearing yaml object keys before raw emit", () => {
    const { ast } = parseYaml("items: []\n");
    expect(() =>
      setOcPath(ast, parseOcPath("oc://x.yaml/items/+"), `{"${REDACTED_SENTINEL}":"2"}`),
    ).toThrow(OcEmitSentinelError);
  });
});
