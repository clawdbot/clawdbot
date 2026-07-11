import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import { validateWorkspaceDoc, type WorkspaceDoc } from "./schema.js";

function validDoc(): WorkspaceDoc {
  return structuredClone(DEFAULT_WORKSPACE);
}

function expectInvalid(mutator: (doc: WorkspaceDoc) => void, message: string) {
  const doc = validDoc();
  mutator(doc);

  expect(() => validateWorkspaceDoc(doc)).toThrow(message);
}

describe("Workspaces document schema", () => {
  it("accepts the default workspace seed", () => {
    expect(validateWorkspaceDoc(validDoc())).toEqual(validDoc());
  });

  it("rejects invalid tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.slug = "Bad Slug";
    }, "tabs[0].slug");
  });

  it("rejects duplicate tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs.push({ ...structuredClone(doc.tabs[0]!), title: "Duplicate" });
    }, "duplicate tab slug");
  });

  it("rejects widget grid overflow", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.grid = { x: 10, y: 0, w: 3, h: 2 };
    }, "x + w");
  });

  it("rejects invalid widget kinds", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.kind = "builtin:unknown";
    }, "widgets[0].kind");
  });

  it("rejects a prototype-setter custom widget kind", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.kind = "custom:__proto__";
    }, "widgets[0].kind");
  });

  it("rejects invalid binding unions", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        bad: { source: "command", value: "date" } as never,
      };
    }, "bindings.bad.source");
  });

  it("rejects non-allowlisted rpc binding methods at write time", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        sessions: { source: "rpc", method: "config.get" },
      };
    }, "bindings.sessions.method is not allowlisted");
  });

  it("accepts bounded parameters for parameterized rpc methods", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = {
      session: { source: "rpc", method: "sessions.get", params: { key: "agent:main:main" } },
    };

    expect(validateWorkspaceDoc(doc).tabs[0]?.widgets[0]?.bindings?.session).toEqual({
      source: "rpc",
      method: "sessions.get",
      params: { key: "agent:main:main" },
    });
  });

  it("rejects prototype-setter binding and widget names", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.bindings = JSON.parse(
      '{"__proto__":{"source":"static","value":1}}',
    ) as WorkspaceDoc["tabs"][number]["widgets"][number]["bindings"];
    expect(() => validateWorkspaceDoc(doc)).toThrow("binding id is invalid");

    doc.tabs[0]!.widgets[0]!.bindings = {};
    doc.widgetsRegistry = JSON.parse(
      '{"__proto__":{"status":"pending","createdBy":"agent:main"}}',
    ) as WorkspaceDoc["widgetsRegistry"];
    expect(() => validateWorkspaceDoc(doc)).toThrow("name is invalid");
  });

  it("rejects non-object and oversized rpc parameters", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        session: { source: "rpc", method: "sessions.get", params: [] } as never,
      };
    }, "bindings.session.params must be an object");
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        session: { source: "rpc", method: "sessions.get", params: { key: "x".repeat(9_000) } },
      };
    }, "bindings.session.params must serialize to 8 KB or less");
  });

  it("rejects tabs and widgets over the caps", () => {
    expectInvalid((doc) => {
      doc.tabs = Array.from({ length: 33 }, (_, index) => ({
        ...structuredClone(doc.tabs[0]!),
        slug: `tab-${index}`,
      }));
    }, "tabs must contain at most 32 entries");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets = Array.from({ length: 25 }, (_, index) => ({
        ...structuredClone(doc.tabs[0]!.widgets[0]!),
        id: `w_${index}`,
      }));
    }, "widgets must contain at most 24 entries");
  });

  it("rejects invalid createdBy provenance", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.createdBy = "robot" as never;
    }, "createdBy");
  });
});
