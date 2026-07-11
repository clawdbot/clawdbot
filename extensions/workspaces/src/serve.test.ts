import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { snapshotApprovedWidget } from "./manifest.js";
import {
  parseWidgetRequestPath,
  serveWidgetAsset,
  WIDGET_CSP,
  WIDGETS_ROUTE_PREFIX,
} from "./serve.js";
import { WorkspaceStore } from "./store.js";

const execFileAsync = promisify(execFile);

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
};

const PARSE_FRAME_TOKEN = "1111111111111111111111111111111111111111111";
let activeFrameToken: string | null = null;

/** Minimal ServerResponse stub capturing status, headers, and body. */
function fakeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: "", ended: false };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
      captured.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function withApprovedWidget<T>(
  run: (ctx: { stateDir: string; store: WorkspaceStore; widgetDir: string }) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-serve-"));
  try {
    const store = new WorkspaceStore({ stateDir });
    const widgetDir = path.join(stateDir, "workspaces", "widgets", "revenue-chart");
    await fs.mkdir(widgetDir, { recursive: true });
    await fs.writeFile(
      path.join(widgetDir, "widget.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "revenue-chart",
        title: "Revenue Chart",
        entrypoint: "index.html",
        bindings: [],
        capabilities: [],
      }),
    );
    await fs.writeFile(path.join(widgetDir, "index.html"), "<!doctype html><h1>ok</h1>");
    await fs.writeFile(path.join(widgetDir, "app.js"), "console.log(1)");
    await fs.writeFile(path.join(widgetDir, "secret.mjs"), "export const x = 1");
    // Approval freezes a digest of every servable file, exactly as the gateway
    // method does; serving compares against it.
    const { files: approvedFiles } = await snapshotApprovedWidget("revenue-chart", { stateDir });
    store.mutate(
      (draft) => {
        draft.widgetsRegistry["revenue-chart"] = {
          status: "approved",
          createdBy: "user",
          approvedBy: "user",
          approvedAt: new Date().toISOString(),
          approvedFiles,
        };
      },
      { actor: "user" },
    );
    activeFrameToken = store.assetTokens.issue("revenue-chart", approvedFiles);
    return await run({ stateDir, store, widgetDir });
  } finally {
    activeFrameToken = null;
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function urlFor(name: string, rest: string): string {
  return `${WIDGETS_ROUTE_PREFIX}/${activeFrameToken ?? PARSE_FRAME_TOKEN}/${name}/${rest}`;
}

describe("parseWidgetRequestPath", () => {
  it("returns null for a pathname not under the widgets prefix", () => {
    expect(parseWidgetRequestPath("/plugins/other/x/y")).toBeNull();
  });

  it("returns null when no logical path is present (name only)", () => {
    expect(
      parseWidgetRequestPath(`${WIDGETS_ROUTE_PREFIX}/${PARSE_FRAME_TOKEN}/revenue-chart`),
    ).toBeNull();
  });

  it("rejects a name failing the charset check", () => {
    expect(
      parseWidgetRequestPath(`${WIDGETS_ROUTE_PREFIX}/${PARSE_FRAME_TOKEN}/../etc/passwd`),
    ).toBeNull();
  });

  it("rejects an encoded traversal segment in the logical path", () => {
    expect(parseWidgetRequestPath(urlFor("revenue-chart", "%2e%2e/secret"))).toBeNull();
  });

  it("parses a valid name and logical path", () => {
    expect(parseWidgetRequestPath(urlFor("revenue-chart", "assets/app.js"))).toEqual({
      frameToken: PARSE_FRAME_TOKEN,
      name: "revenue-chart",
      logicalPath: "assets/app.js",
    });
  });
});

describe("serveWidgetAsset security jail", () => {
  it("serves an approved widget's index.html with strict headers", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      const handled = await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "index.html") },
        res,
        { store, stateDir },
      );
      expect(handled).toBe(true);
      expect(captured.statusCode).toBe(200);
      expect(captured.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(captured.headers["content-security-policy"]).toBe(WIDGET_CSP);
      // The response itself enforces the same opaque-origin sandbox as the
      // iframe, so opening this URL directly cannot regain same-origin access.
      expect(captured.headers["content-security-policy"]).toContain("sandbox allow-scripts");
      expect(captured.headers["content-security-policy"]).not.toContain("allow-same-origin");
      expect(captured.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(captured.headers["x-content-type-options"]).toBe("nosniff");
      expect(captured.headers["referrer-policy"]).toBe("no-referrer");
      expect(captured.body).toContain("<h1>ok</h1>");
    });
  });

  it("injects a document-bound MessageChannel bootstrap before approved html", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        {
          method: "GET",
          pathname: urlFor("revenue-chart", "index.html"),
        },
        res,
        { store, stateDir },
      );

      expect(captured.statusCode).toBe(200);
      expect(captured.body).toContain("new MessageChannel()");
      expect(captured.body).toContain(`token:"${activeFrameToken}"`);
      expect(captured.body.startsWith("<!doctype html><script>")).toBe(true);
      expect(captured.body.indexOf("new MessageChannel()")).toBeLessThan(
        captured.body.indexOf("<h1>ok</h1>"),
      );
    });
  });

  it("404s a malformed frame token", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        {
          method: "GET",
          pathname: `${WIDGETS_ROUTE_PREFIX}/bad-token/revenue-chart/index.html`,
        },
        res,
        { store, stateDir },
      );

      expect(captured.statusCode).toBe(404);
    });
  });

  it("keeps leading comments and the doctype ahead of the bootstrap", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      const html = `<!-- license -->\n<!doctype html><h1>ok</h1>`;
      await fs.writeFile(path.join(widgetDir, "index.html"), html);
      const { files: approvedFiles } = await snapshotApprovedWidget("revenue-chart", { stateDir });
      store.mutate(
        (draft) => {
          draft.widgetsRegistry["revenue-chart"]!.approvedFiles = approvedFiles;
        },
        { actor: "user" },
      );
      activeFrameToken = store.assetTokens.issue("revenue-chart", approvedFiles);
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        {
          method: "GET",
          pathname: urlFor("revenue-chart", "index.html"),
        },
        res,
        { store, stateDir },
      );

      expect(captured.body.startsWith(`<!-- license -->\n<!doctype html><script>`)).toBe(true);
    });
  });

  it("serves a .js asset with the allowlisted content type + CSP + nosniff", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset({ method: "GET", pathname: urlFor("revenue-chart", "app.js") }, res, {
        store,
        stateDir,
      });
      expect(captured.statusCode).toBe(200);
      expect(captured.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(captured.headers["content-security-policy"]).toBe(WIDGET_CSP);
      expect(captured.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  it("returns false (not handled) for a pathname outside the route", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res } = fakeResponse();
      const handled = await serveWidgetAsset(
        { method: "GET", pathname: "/plugins/canvas/host/x" },
        res,
        { store, stateDir },
      );
      expect(handled).toBe(false);
    });
  });

  const traversalCases: Array<{ label: string; pathname: string }> = [
    { label: "dot-dot traversal", pathname: urlFor("revenue-chart", "../secret.txt") },
    { label: "encoded %2e%2e traversal", pathname: urlFor("revenue-chart", "%2e%2e/secret.txt") },
    {
      label: "absolute path",
      pathname: `${WIDGETS_ROUTE_PREFIX}/${PARSE_FRAME_TOKEN}/revenue-chart//etc/passwd`,
    },
    { label: "backslash traversal", pathname: urlFor("revenue-chart", "..%5csecret.txt") },
    {
      label: "name charset violation",
      pathname: `${WIDGETS_ROUTE_PREFIX}/${PARSE_FRAME_TOKEN}/..%2f..%2fx/index.html`,
    },
  ];

  for (const { label, pathname } of traversalCases) {
    it(`404s on ${label}`, async () => {
      await withApprovedWidget(async ({ store, stateDir }) => {
        const { res, captured } = fakeResponse();
        await serveWidgetAsset({ method: "GET", pathname }, res, { store, stateDir });
        expect(captured.statusCode).toBe(404);
        // A 404 is still an attacker-influenced response from the widget origin,
        // so it MUST carry the same strict CSP as a 200 (invariant I1/I4).
        expect(captured.headers["content-security-policy"]).toBe(WIDGET_CSP);
        expect(captured.headers["referrer-policy"]).toBe("no-referrer");
      });
    });
  }

  it("404s (never 403) on a symlink that escapes the widget dir", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      const outsideFile = path.join(stateDir, "outside-secret.txt");
      await fs.writeFile(outsideFile, "top secret");
      await fs.symlink(outsideFile, path.join(widgetDir, "leak.txt"));
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "leak.txt") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s a post-approval hardlink even when its bytes match the approved file", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      const appPath = path.join(widgetDir, "app.js");
      const approvedBytes = await fs.readFile(appPath);
      const outsideFile = path.join(stateDir, "outside-app.js");
      await fs.writeFile(outsideFile, approvedBytes);
      await fs.rm(appPath);
      await fs.link(outsideFile, appPath);

      const { res, captured } = fakeResponse();
      await serveWidgetAsset({ method: "GET", pathname: urlFor("revenue-chart", "app.js") }, res, {
        store,
        stateDir,
      });
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s a symlink substituted for the approved widget directory", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      const outsideDir = path.join(stateDir, "outside-widget");
      await fs.rename(widgetDir, outsideDir);
      await fs.symlink(outsideDir, widgetDir, "dir");

      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "index.html") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it.runIf(process.platform !== "win32")(
    "404s a post-approval named pipe without blocking",
    async () => {
      await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
        const appPath = path.join(widgetDir, "app.js");
        await fs.rm(appPath);
        await execFileAsync("mkfifo", [appPath]);

        const { res, captured } = fakeResponse();
        await serveWidgetAsset(
          { method: "GET", pathname: urlFor("revenue-chart", "app.js") },
          res,
          { store, stateDir },
        );
        expect(captured.statusCode).toBe(404);
      });
    },
  );

  it("404s on a non-GET method", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const { res, captured } = fakeResponse();
        await serveWidgetAsset({ method, pathname: urlFor("revenue-chart", "index.html") }, res, {
          store,
          stateDir,
        });
        expect(captured.statusCode).toBe(404);
      }
    });
  });

  it("404s on a disallowed extension even when the file exists", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "secret.mjs") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s assets for a pending (not approved) widget", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const pendingDir = path.join(stateDir, "workspaces", "widgets", "pending-widget");
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, "index.html"), "<h1>pending</h1>");
      store.mutate(
        (draft) => {
          draft.widgetsRegistry["pending-widget"] = { status: "pending", createdBy: "agent:x" };
        },
        { actor: "user" },
      );
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("pending-widget", "index.html") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s assets for a rejected widget", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const rejectedDir = path.join(stateDir, "workspaces", "widgets", "rejected-widget");
      await fs.mkdir(rejectedDir, { recursive: true });
      await fs.writeFile(path.join(rejectedDir, "index.html"), "<h1>rejected</h1>");
      store.mutate(
        (draft) => {
          draft.widgetsRegistry["rejected-widget"] = { status: "rejected", createdBy: "agent:x" };
        },
        { actor: "user" },
      );
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("rejected-widget", "index.html") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s a missing file inside an approved widget dir", async () => {
    await withApprovedWidget(async ({ store, stateDir }) => {
      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "does-not-exist.css") },
        res,
        { store, stateDir },
      );
      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s a file whose bytes changed after approval", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      // The gate approves code, not a directory name. Rewriting the entrypoint
      // after approval must not reach a browser.
      await fs.writeFile(path.join(widgetDir, "index.html"), "<script>evil()</script>");

      const { res, captured } = fakeResponse();
      await serveWidgetAsset(
        { method: "GET", pathname: urlFor("revenue-chart", "index.html") },
        res,
        { store, stateDir },
      );

      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s a file added after approval", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      await fs.writeFile(path.join(widgetDir, "late.js"), "evil()");

      const { res, captured } = fakeResponse();
      await serveWidgetAsset({ method: "GET", pathname: urlFor("revenue-chart", "late.js") }, res, {
        store,
        stateDir,
      });

      expect(captured.statusCode).toBe(404);
    });
  });

  it("404s an oversized file without reading it", async () => {
    await withApprovedWidget(async ({ store, stateDir, widgetDir }) => {
      // Approved files stay writable: a swapped-in giant asset must be refused on
      // its size, not buffered and then hash-checked.
      await fs.writeFile(path.join(widgetDir, "app.js"), Buffer.alloc(2 * 1024 * 1024 + 1));

      const { res, captured } = fakeResponse();
      await serveWidgetAsset({ method: "GET", pathname: urlFor("revenue-chart", "app.js") }, res, {
        store,
        stateDir,
      });

      expect(captured.statusCode).toBe(404);
    });
  });
});
