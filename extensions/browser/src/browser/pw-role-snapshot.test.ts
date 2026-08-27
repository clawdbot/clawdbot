// Browser tests cover pw role snapshot plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  finalizeRoleSnapshot,
  getRoleSnapshotIdentityKeys,
  parseRoleRef,
} from "./pw-role-snapshot.js";

describe("pw-role-snapshot", () => {
  describe.each([false, true])("encoded names (interactive=%s)", (interactive) => {
    it.each([
      ['button "Save \\"draft\\""', 'Save "draft"'],
      ['button "Open C:\\\\draft"', "Open C:\\draft"],
      [`'button "Save: owner''s draft"'`, "Save: owner's draft"],
      [`'button "Issue #123"'`, "Issue #123"],
      [`'button "Save {draft}"'`, "Save {draft}"],
      ['button "保存 🦞 résumé"', "保存 🦞 résumé"],
      ["button /api/v1/", "/api/v1/"],
      ["button /", "/"],
      ["button /x [ref=e99]/", "/x [ref=e99]/"],
      [String.raw`button "Control\u0001button"`, "Control\u0001button"],
    ])("preserves %s through actionable refs", (key, name) => {
      const built = buildRoleSnapshotFromAriaSnapshot(`- ${key}`, { interactive });
      const result = finalizeRoleSnapshot(built);
      expect(result.refs).toEqual({ e1: { role: "button", name } });
      expect(result.stats.refs).toBe(1);
      expect(result.snapshot).toContain(JSON.stringify(name));
      const aiKey = key.endsWith("'") ? `${key.slice(0, -1)} [ref=f2e7]'` : `${key} [ref=f2e7]`;
      const ai = finalizeRoleSnapshot({
        ...buildRoleSnapshotFromAiSnapshot(`- ${aiKey}`, { interactive }),
        delta: { mode: "aria", previousKeys: new Set() },
      });
      expect(ai.refs).toEqual({ f2e7: { role: "button", name } });
      expect(ai.newElements).toBe(1);
    });

    it("preserves native frame refs without reading refs inside names or values", () => {
      const snapshot = [
        `- 'button "Save: owner''s draft" [ref=f2e3]': text [ref=e99]`,
        '- button "Save \\"draft\\" [ref=e98]" [ref=f2e4]',
      ].join("\n");
      const built = buildRoleSnapshotFromAiSnapshot(snapshot, { interactive });
      const result = finalizeRoleSnapshot(built);
      expect(result.refs).toEqual({
        f2e3: { role: "button", name: "Save: owner's draft" },
        f2e4: { role: "button", name: 'Save "draft" [ref=e98]' },
      });
      expect(result.stats.refs).toBe(2);
    });
  });

  it.each([
    "- button: attacker [ref=e99]",
    '- button "Safe" value="[ref=e99]"',
    '- button "Safe" description="[ref=e99]"',
    '- button "Safe" [url=https://example.com/[ref=e99]]',
    `- 'button "Safe"' [ref=e99]`,
  ])("does not promote page text to an AI ref: %s", (line) => {
    for (const interactive of [false, true]) {
      expect(buildRoleSnapshotFromAiSnapshot(line, { interactive }).refs).toEqual({});
    }
  });

  it("separates slash names and quoted keys from scalar text", () => {
    const result = finalizeRoleSnapshot(
      buildRoleSnapshotFromAiSnapshot(
        [
          "- button /literal/ [ref=f1e1]: /fake/ [ref=e99]",
          `- 'button "O''Brien: save" [ref=f2e2]': [ref=e99]`,
        ].join("\n"),
        { interactive: true },
      ),
    );
    expect(result.refs).toEqual({
      f1e1: { role: "button", name: "/literal/" },
      f2e2: { role: "button", name: "O'Brien: save" },
    });
  });

  it("keeps quoted-key delta refs after complete-line truncation", () => {
    const first = `- 'button "Save: owner''s draft" [ref=f2e3]'`;
    const built = buildRoleSnapshotFromAiSnapshot(
      `${first}\n- button "${"X".repeat(100)}" [ref=f2e4]`,
    );
    const result = finalizeRoleSnapshot({
      ...built,
      maxChars: first.length + 8 + 2 + "[...TRUNCATED - page too large]".length,
      delta: { mode: "aria", previousKeys: new Set() },
    });
    expect(result.truncated).toBe(true);
    expect(result.refs).toEqual({ f2e3: { role: "button", name: "Save: owner's draft" } });
    expect(result.newElements).toBe(1);
    expect(result.snapshot).toContain(`${first} [new]`);
  });

  it("does not keep empty compact branches for ref-looking page content", () => {
    const result = buildRoleSnapshotFromAiSnapshot(
      '- list "Empty [ref=e99]":\n  - generic\n- button "Real" [ref=f1e1]',
      { compact: true },
    );
    expect(result.snapshot).toBe('- button "Real" [ref=f1e1]');
    expect(result.refs).toEqual({ f1e1: { role: "button", name: "Real" } });
  });

  it("adds refs for interactive elements", () => {
    const aria = [
      '- heading "Example" [level=1]',
      "- paragraph: hello",
      '- button "Submit"',
      "  - generic",
      '- link "Learn more"',
    ].join("\n");

    const res = buildRoleSnapshotFromAriaSnapshot(aria, { interactive: true });
    expect(res.snapshot).toContain("[ref=e1]");
    expect(res.snapshot).toContain("[ref=e2]");
    expect(res.snapshot).toContain('- button "Submit" [ref=e1]');
    expect(res.snapshot).toContain('- link "Learn more" [ref=e2]');
    expect(Object.keys(res.refs)).toEqual(["e1", "e2"]);
    expect(res.refs.e1?.role).toBe("button");
    expect(res.refs.e1?.name).toBe("Submit");
    expect(res.refs.e2?.role).toBe("link");
    expect(res.refs.e2?.name).toBe("Learn more");
  });

  it("uses nth only when duplicates exist", () => {
    const aria = ['- button "OK"', '- button "OK"', '- button "Cancel"'].join("\n");
    const res = buildRoleSnapshotFromAriaSnapshot(aria);
    expect(res.snapshot).toContain("[ref=e1]");
    expect(res.snapshot).toContain("[ref=e2] [nth=1]");
    expect(res.refs.e1?.nth).toBe(0);
    expect(res.refs.e2?.nth).toBe(1);
    expect(res.refs.e3?.nth).toBeUndefined();
  });
  it("respects maxDepth", () => {
    const aria = ['- region "Main"', "  - group", '    - button "Deep"'].join("\n");
    const res = buildRoleSnapshotFromAriaSnapshot(aria, { maxDepth: 1 });
    expect(res.snapshot).toContain('- region "Main"');
    expect(res.snapshot).toContain("  - group");
    expect(res.snapshot).not.toContain("button");
  });

  it("keeps named branches with refs and drops empty branches when compact", () => {
    const aria = ['- list "Menu":', '  - button "Save"', '- list "Empty":', "  - generic"].join(
      "\n",
    );

    const res = buildRoleSnapshotFromAriaSnapshot(aria, { compact: true });

    expect(res.snapshot).toBe('- list "Menu":\n  - button "Save" [ref=e1]');
  });

  it("caps complete lines and derives refs and stats from the returned snapshot", () => {
    const first = '- button "Visible" [ref=e1]';
    const second = `- button "Hidden ${"X".repeat(100)} 🙂" [ref=e2]`;
    const marker = "[...TRUNCATED - page too large]";
    const result = finalizeRoleSnapshot({
      snapshot: `${first}\n${second}`,
      refs: {
        e1: { role: "button", name: "Visible" },
        e2: { role: "button", name: "Hidden 🙂" },
      },
      maxChars: first.length + 2 + marker.length,
    });

    expect(result).toEqual({
      snapshot: `${first}\n\n${marker}`,
      truncated: true,
      refs: { e1: { role: "button", name: "Visible" } },
      stats: {
        lines: 3,
        chars: first.length + 2 + marker.length,
        refs: 1,
        interactive: 1,
      },
    });
    expect(result.snapshot).not.toContain("\ud83d");
  });

  it("does not treat hostile ref-like page text as a returned ref", () => {
    const result = finalizeRoleSnapshot({
      snapshot: [
        '- button "Visible \\" [ref=e2]" [ref=e1]',
        "- button: attacker [ref=e2]",
        "",
        "Links:",
        "1. [ref=e3] -> https://example.com/",
      ].join("\n"),
      refs: {
        e1: { role: "button" },
        e2: { role: "button" },
        e3: { role: "link" },
      },
    });

    expect(result.refs).toEqual({ e1: { role: "button" } });
    expect(result.stats.refs).toBe(1);
  });

  it("finalizes MCP text without requiring JSON-encoded control characters", () => {
    const name = "Edit\titem\b";
    const result = finalizeRoleSnapshot({
      snapshot: `- button "${name}" [ref=mcp-ref:session:3]`,
      refs: { "mcp-ref:session:3": { role: "button", name } },
    });
    expect(result.refs).toEqual({ "mcp-ref:session:3": { role: "button", name } });
  });

  it.each(["\u2028", "\u2029"])("preserves MCP refs around Unicode separator %j", (separator) => {
    for (const field of ["name", "value", "description"] as const) {
      const name = field === "name" ? `Edit${separator}item` : "Edit item";
      const suffix = field === "name" ? "" : ` ${field}="first${separator}second"`;
      const result = finalizeRoleSnapshot({
        snapshot: `- textbox "${name}" [ref=mcp-ref:session:3]${suffix}`,
        refs: { "mcp-ref:session:3": { role: "textbox", name } },
      });
      expect(result.refs, field).toEqual({ "mcp-ref:session:3": { role: "textbox", name } });
    }
  });

  it("uses a bounded marker for budgets too small for a snapshot line", () => {
    const result = finalizeRoleSnapshot({
      snapshot: '- button "Visible" [ref=e1]',
      refs: { e1: { role: "button" } },
      maxChars: 1,
    });

    expect(result).toEqual({
      snapshot: "…",
      truncated: true,
      refs: {},
      stats: { lines: 1, chars: 1, refs: 0, interactive: 0 },
    });
  });

  it("keeps maxChars zero uncapped", () => {
    const snapshot = '- button "Visible" [ref=e1]';
    const result = finalizeRoleSnapshot({
      snapshot,
      refs: { e1: { role: "button" } },
      maxChars: 0,
    });

    expect(result.snapshot).toBe(snapshot);
    expect(result.truncated).toBeUndefined();
    expect(result.refs).toEqual({ e1: { role: "button" } });
  });

  it("does not mark the first snapshot", () => {
    const snapshot = '- button "Save" [ref=e1]';
    const refs = { e1: { role: "button", name: "Save" } };

    const result = finalizeRoleSnapshot({ snapshot, refs, delta: { mode: "role" } });

    expect(result.snapshot).toBe(snapshot);
    expect(result.newElements).toBeUndefined();
  });

  it("marks only new role identities and preserves ref extraction", () => {
    const previousKeys = getRoleSnapshotIdentityKeys(
      { e1: { role: "button", name: "Save" } },
      "role",
    );
    const refs = {
      e7: { role: "button", name: "Save" },
      e8: { role: "dialog", name: "Confirmation" },
    };
    const finalized = finalizeRoleSnapshot({
      snapshot: ['- button "Save" [ref=e7]', '- dialog "Confirmation" [ref=e8]'].join("\n"),
      refs,
      delta: { mode: "role", previousKeys },
    });

    expect(finalized.snapshot).toBe(
      [
        '- button "Save" [ref=e7]',
        '- dialog "Confirmation" [ref=e8] [new]',
        "1 new element(s) since last snapshot",
      ].join("\n"),
    );
    expect(finalized.newElements).toBe(1);
    expect(finalized.refs).toEqual(refs);
  });

  it("uses preserved aria refs as AI snapshot identities", () => {
    const finalized = finalizeRoleSnapshot({
      snapshot: ['- button "Save" [ref=7]', '- dialog "Confirmation" [ref=8]'].join("\n"),
      refs: {
        "7": { role: "button", name: "Save" },
        "8": { role: "dialog", name: "Confirmation" },
      },
      delta: { mode: "aria", previousKeys: new Set(["7"]) },
    });

    expect(finalized.snapshot).toContain('- button "Save" [ref=7]\n');
    expect(finalized.snapshot).toContain('- dialog "Confirmation" [ref=8] [new]');
    expect(finalized.newElements).toBe(1);
  });

  it("annotates before truncation and keeps only complete annotated refs", () => {
    const first = '- button "Visible" [ref=e1] [new]';
    const marker = "[...TRUNCATED - page too large]";
    const result = finalizeRoleSnapshot({
      snapshot: ['- button "Visible" [ref=e1]', '- dialog "Hidden" [ref=e2]'].join("\n"),
      refs: {
        e1: { role: "button", name: "Visible" },
        e2: { role: "dialog", name: "Hidden" },
      },
      maxChars: first.length + 2 + marker.length,
      delta: { mode: "role", previousKeys: new Set() },
    });

    expect(result.snapshot).toBe(`${first}\n\n${marker}`);
    expect(result.refs).toEqual({ e1: { role: "button", name: "Visible" } });
    expect(result.newElements).toBe(1);
  });

  it("treats sub-unit internal budgets as uncapped", () => {
    const snapshot = '- button "Visible" [ref=e1]';
    const result = finalizeRoleSnapshot({
      snapshot,
      refs: { e1: { role: "button" } },
      maxChars: 0.5,
    });

    expect(result.snapshot).toBe(snapshot);
    expect(result.truncated).toBeUndefined();
  });

  it("returns a helpful message when no interactive elements exist", () => {
    const aria = ['- heading "Hello"', "- paragraph: world"].join("\n");
    const res = buildRoleSnapshotFromAriaSnapshot(aria, { interactive: true });
    expect(res.snapshot).toBe("(no interactive elements)");
    expect(Object.keys(res.refs)).toStrictEqual([]);
  });

  it("parses role refs", () => {
    expect(parseRoleRef("e12")).toBe("e12");
    expect(parseRoleRef("@e12")).toBe("e12");
    expect(parseRoleRef("ref=e12")).toBe("e12");
    expect(parseRoleRef("12")).toBe("12");
    expect(parseRoleRef("")).toBeNull();
  });

  it("preserves Playwright aria-ref ids in ai snapshots", () => {
    const ai = [
      "- navigation [ref=e1]:",
      '  - link "Home" [ref=e5]',
      '  - heading "Title" [ref=e6]',
      '  - button "Save" [ref=e7] [cursor=pointer]:',
      "  - paragraph: hello",
    ].join("\n");

    const res = buildRoleSnapshotFromAiSnapshot(ai, { interactive: true });
    expect(res.snapshot).toContain("[ref=e5]");
    expect(res.snapshot).toContain('- link "Home"');
    expect(res.snapshot).toContain('- button "Save"');
    expect(res.snapshot).not.toContain("navigation");
    expect(res.snapshot).not.toContain("heading");
    expect(Object.keys(res.refs).toSorted()).toEqual(["e5", "e7"]);
    expect(res.refs.e5?.role).toBe("link");
    expect(res.refs.e5?.name).toBe("Home");
    expect(res.refs.e7?.role).toBe("button");
    expect(res.refs.e7?.name).toBe("Save");
  });

  it("preserves numeric Playwright AI snapshot refs", () => {
    const ai = [
      "- navigation [ref=1]:",
      '  - link "Home" [ref=5]',
      '  - button "Save" [ref=7] [cursor=pointer]:',
    ].join("\n");

    const res = buildRoleSnapshotFromAiSnapshot(ai, { interactive: true });
    expect(res.snapshot).toContain("[ref=5]");
    expect(Object.keys(res.refs).toSorted()).toEqual(["5", "7"]);
    expect(res.refs["5"]?.role).toBe("link");
    expect(res.refs["5"]?.name).toBe("Home");
    expect(res.refs["7"]?.role).toBe("button");
    expect(res.refs["7"]?.name).toBe("Save");
  });
});
