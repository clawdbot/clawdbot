import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWidgetDir, snapshotApprovedWidget, validateWidgetManifest } from "./manifest.js";

const VALID_MANIFEST = {
  schemaVersion: 1,
  name: "revenue-chart",
  title: "Revenue Chart",
  entrypoint: "index.html",
  bindings: [{ id: "rev", source: "static", value: { revenue: 42 } }],
  capabilities: ["data:read"],
  preferredSize: { w: 6, h: 4 },
};

describe("validateWidgetManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateWidgetManifest(VALID_MANIFEST)).toEqual(VALID_MANIFEST);
  });

  it("rejects a future schemaVersion", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, schemaVersion: 2 })).toThrow(
      /schemaVersion must be 1/,
    );
  });

  it("rejects an invalid widget name charset", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, name: "../evil" })).toThrow(
      /name is invalid/,
    );
  });

  it("rejects prototype-setter widget and binding names", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, name: "__proto__" })).toThrow(
      /name is invalid/,
    );
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [{ id: "__proto__", source: "static", value: 1 }],
      }),
    ).toThrow(/id is invalid/);
  });

  it("rejects rpc bindings for custom code", () => {
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [{ id: "x", source: "rpc", method: "sessions.delete" }],
      }),
    ).toThrow(/source must be static/);
  });

  it("rejects file bindings for custom code", () => {
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [{ id: "x", source: "file", path: "../../etc/passwd" }],
      }),
    ).toThrow(/source must be static/);
  });

  it("rejects an entrypoint that escapes the widget dir", () => {
    expect(() =>
      validateWidgetManifest({ ...VALID_MANIFEST, entrypoint: "../index.html" }),
    ).toThrow();
  });

  it("rejects an unknown capability", () => {
    expect(() =>
      validateWidgetManifest({ ...VALID_MANIFEST, capabilities: ["data:write"] }),
    ).toThrow(/capability is invalid/);
  });

  it("accepts the prompt:send capability", () => {
    const manifest = validateWidgetManifest({
      ...VALID_MANIFEST,
      capabilities: ["data:read", "prompt:send"],
    });
    expect(manifest.capabilities).toEqual(["data:read", "prompt:send"]);
  });

  it("rejects duplicate binding ids", () => {
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [
          { id: "dup", source: "static", value: 1 },
          { id: "dup", source: "static", value: 2 },
        ],
      }),
    ).toThrow(/duplicate binding id/);
  });

  it("rejects unexpected top-level keys", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, extra: true })).toThrow(
      /is not allowed/,
    );
  });

  it("rejects a name that does not match the directory when expected", () => {
    expect(() => validateWidgetManifest(VALID_MANIFEST, "other-name")).toThrow(
      /does not match its directory/,
    );
  });
});

describe("resolveWidgetDir", () => {
  it("rejects a name with a path separator", () => {
    expect(() => resolveWidgetDir("a/b")).toThrow(/name is invalid/);
  });

  it("rejects a traversal name", () => {
    expect(() => resolveWidgetDir("..")).toThrow(/name is invalid/);
  });

  it("resolves a valid name under the widgets root", () => {
    const dir = resolveWidgetDir("revenue-chart", "/tmp/state");
    expect(dir).toBe(path.resolve("/tmp/state", "workspaces", "widgets", "revenue-chart"));
  });
});

describe("snapshotApprovedWidget", () => {
  it("parses the manifest from the same bytes it hashes", async () => {
    await withWidget(async ({ stateDir, widgetDir }) => {
      const snapshot = await snapshotApprovedWidget("demo", { stateDir });
      const digestOfHashedManifest = snapshot.files["widget.json"];

      // The manifest the caller receives must be the one whose digest was frozen:
      // reading widget.json twice would let it change in between, so an operator
      // could validate one entrypoint while a different one got served.
      const bytes = await fs.readFile(path.join(widgetDir, "widget.json"));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digestOfHashedManifest);
      expect(snapshot.manifest.entrypoint).toBe("index.html");
      expect(snapshot.files[snapshot.manifest.entrypoint]).toBeDefined();
    });
  });

  it("refuses a widget whose declared entrypoint does not exist", async () => {
    await withWidget(async ({ stateDir, widgetDir }) => {
      await fs.rm(path.join(widgetDir, "index.html"));

      await expect(snapshotApprovedWidget("demo", { stateDir })).rejects.toThrow(
        "entrypoint is missing",
      );
    });
  });

  it("refuses to hash an oversized widget asset", async () => {
    await withWidget(async ({ stateDir, widgetDir }) => {
      // Pending widget files are agent-authored; approval must not read an
      // arbitrarily large file into memory.
      await fs.writeFile(path.join(widgetDir, "huge.png"), Buffer.alloc(2 * 1024 * 1024 + 1));

      await expect(snapshotApprovedWidget("demo", { stateDir })).rejects.toThrow("too large");
    });
  });

  it("refuses to approve a hardlink to a file outside the widget directory", async () => {
    await withWidget(async ({ stateDir, widgetDir }) => {
      const outsideFile = path.join(stateDir, "outside-secret.txt");
      await fs.writeFile(outsideFile, "top secret");
      await fs.link(outsideFile, path.join(widgetDir, "leak.txt"));

      await expect(snapshotApprovedWidget("demo", { stateDir })).rejects.toThrow(
        "widget file is unsafe: leak.txt",
      );
    });
  });

  it("refuses to approve a symlink substituted for the widget directory", async () => {
    await withWidget(async ({ stateDir, widgetDir }) => {
      const outsideDir = path.join(stateDir, "outside-widget");
      await fs.rename(widgetDir, outsideDir);
      await fs.symlink(outsideDir, widgetDir, "dir");

      await expect(snapshotApprovedWidget("demo", { stateDir })).rejects.toThrow();
    });
  });

  it("refuses a widget with no manifest at all", async () => {
    await withWidget(async ({ stateDir, widgetDir }) => {
      await fs.rm(path.join(widgetDir, "widget.json"));

      await expect(snapshotApprovedWidget("demo", { stateDir })).rejects.toThrow("not found");
    });
  });
});

async function withWidget(
  run: (ctx: { stateDir: string; widgetDir: string }) => Promise<void>,
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-manifest-"));
  try {
    const widgetDir = path.join(stateDir, "workspaces", "widgets", "demo");
    await fs.mkdir(widgetDir, { recursive: true });
    await fs.writeFile(
      path.join(widgetDir, "widget.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "demo",
        title: "Demo",
        entrypoint: "index.html",
        bindings: [],
        capabilities: [],
      }),
    );
    await fs.writeFile(path.join(widgetDir, "index.html"), "<h1>demo</h1>");
    await run({ stateDir, widgetDir });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
