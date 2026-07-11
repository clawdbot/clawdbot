import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCli, parseWorkspaceBindingShorthand } from "./cli.js";
import { registerWorkspaceGatewayMethods } from "./gateway.js";
import { WorkspaceStore } from "./store.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
  };
});

type RegisteredMethod = {
  handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
};

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-cli-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createProgram(stateDir?: string): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerWorkspaceCli({ program, stateDir });
  return program;
}

function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  return run()
    .then(() => chunks.join(""))
    .finally(() => {
      write.mockRestore();
    });
}

function installGatewayMock(store: WorkspaceStore) {
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    registerGatewayMethod: vi.fn((method: string, handler: RegisteredMethod["handler"]) => {
      methods.set(method, { handler });
    }),
  } as unknown as OpenClawPluginApi;
  registerWorkspaceGatewayMethods({ api, store });
  const broadcast = vi.fn();
  gatewayRuntime.callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params: unknown) => {
      const entry = methods.get(method);
      if (!entry) {
        throw new Error(`unknown method: ${method}`);
      }
      const respond = vi.fn();
      await entry.handler({
        params: params ?? {},
        respond,
        context: { broadcast },
      } as never);
      const [ok, result, error] = respond.mock.calls[0] ?? [];
      if (ok) {
        return result;
      }
      throw new Error(error?.message ?? "gateway error");
    },
  );
  return { broadcast };
}

describe("workspace CLI", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
  });

  it("parses binding shorthand sources and rejects malformed values", () => {
    expect(parseWorkspaceBindingShorthand("value=file:q3.json#/revenue")).toEqual([
      "value",
      { source: "file", path: "q3.json", pointer: "/revenue" },
    ]);
    expect(parseWorkspaceBindingShorthand("rows=rpc:sessions.list")).toEqual([
      "rows",
      { source: "rpc", method: "sessions.list" },
    ]);
    expect(parseWorkspaceBindingShorthand('value=static:{"ok":true}')).toEqual([
      "value",
      { source: "static", value: { ok: true } },
    ]);

    expect(() => parseWorkspaceBindingShorthand("file:q3.json")).toThrow("binding must be");
    expect(() => parseWorkspaceBindingShorthand("value=static:{bad")).toThrow("invalid static");
    expect(() => parseWorkspaceBindingShorthand("value=command:date")).toThrow("binding source");
  });

  it("round-trips tabs and widgets through the L1 gateway methods", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const { broadcast } = installGatewayMock(store);
      const program = createProgram(stateDir);

      await captureStdout(async () => {
        await program.parseAsync(
          ["workspaces", "tabs", "create", "--title", "Finance Ops", "--slug", "finance"],
          { from: "user" },
        );
      });
      await captureStdout(async () => {
        await program.parseAsync(
          [
            "workspaces",
            "widgets",
            "add",
            "--tab",
            "finance",
            "--kind",
            "builtin:stat-card",
            "--title",
            "Q3 Revenue",
            "--binding",
            "value=file:q3.json#/revenue",
            "--props",
            '{"format":"usd"}',
          ],
          { from: "user" },
        );
      });

      const output = await captureStdout(async () => {
        await program.parseAsync(["workspaces", "widgets", "list", "--tab", "finance", "--json"], {
          from: "user",
        });
      });
      expect(JSON.parse(output)).toMatchObject({
        widgets: [
          {
            title: "Q3 Revenue",
            grid: { x: 0, y: 0, w: 4, h: 2 },
            bindings: { value: { source: "file", path: "q3.json", pointer: "/revenue" } },
            props: { format: "usd" },
          },
        ],
      });
      expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
        "workspaces.widget.add",
        expect.any(Object),
        expect.objectContaining({ tab: "finance" }),
        expect.objectContaining({ mode: "cli", scopes: ["operator.write", "operator.read"] }),
      );
      expect(broadcast).toHaveBeenCalledWith("plugin.workspaces.changed", {
        workspaceVersion: 3,
        changedTabSlug: "finance",
        actor: "user",
      });
    });
  });

  it("uses workspace get/replace for layout set and rejects invalid local docs", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      installGatewayMock(store);
      const program = createProgram(stateDir);
      const before = store.read();
      const replacement = structuredClone(before);
      replacement.tabs[0]!.title = "Renamed";
      const filePath = path.join(stateDir, "workspace.json");
      await fs.writeFile(filePath, JSON.stringify(replacement), "utf8");

      await captureStdout(async () => {
        await program.parseAsync(["workspaces", "layout", "set", "--file", filePath], {
          from: "user",
        });
      });
      expect(store.read().tabs[0]?.title).toBe("Renamed");

      await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1 }), "utf8");
      await expect(
        program.parseAsync(["workspaces", "layout", "set", "--file", filePath], {
          from: "user",
        }),
      ).rejects.toThrow("workspaceVersion");
    });
  });

  it("round-trips every remaining subcommand through the gateway", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      installGatewayMock(store);
      const program = createProgram(stateDir);

      const run = async (args: string[]) => {
        await captureStdout(async () => {
          await program.parseAsync(args, { from: "user" });
        });
      };

      await run(["workspaces", "tabs", "create", "--title", "Ops", "--slug", "ops"]);
      await run(["workspaces", "tabs", "hide", "ops"]);
      await run(["workspaces", "tabs", "show", "ops"]);
      await run(["workspaces", "tabs", "reorder", "ops", "main"]);
      await run([
        "workspaces",
        "widgets",
        "add",
        "--tab",
        "ops",
        "--id",
        "notes",
        "--kind",
        "builtin:markdown",
        "--title",
        "Notes",
        "--grid",
        "0,0,4,2",
      ]);
      await run([
        "workspaces",
        "widgets",
        "update",
        "--tab",
        "ops",
        "--id",
        "notes",
        "--title",
        "Updated Notes",
        "--collapsed",
        "true",
        "--hidden",
        "false",
      ]);
      await run([
        "workspaces",
        "widgets",
        "move",
        "--tab",
        "ops",
        "--id",
        "notes",
        "--grid",
        "4,0,4,2",
      ]);
      await run(["workspaces", "tabs", "create", "--title", "Other", "--slug", "other"]);
      await run(["workspaces", "widgets", "move", "--id", "notes", "--to-tab", "other"]);
      await run(["workspaces", "widgets", "remove", "--tab", "other", "--id", "notes"]);
      const layout = await captureStdout(async () => {
        await program.parseAsync(["workspaces", "layout", "get", "--json"], { from: "user" });
      });
      expect(JSON.parse(layout)).toMatchObject({ doc: { tabs: expect.any(Array) } });
      await run(["workspaces", "layout", "undo"]);
      await run(["workspaces", "tabs", "delete", "other"]);

      const doc = store.read();
      expect(doc.prefs.tabOrder).toContain("ops");
      expect(doc.tabs.some((tab) => tab.slug === "other")).toBe(false);
    });
  });

  it("rejects invalid CLI inputs before or through gateway validation", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      installGatewayMock(store);
      const program = createProgram(stateDir);

      await captureStdout(async () => {
        await program.parseAsync(
          ["workspaces", "tabs", "create", "--title", "Ops", "--slug", "ops"],
          {
            from: "user",
          },
        );
      });

      await expect(
        program.parseAsync(["workspaces", "tabs", "reorder", "Bad"], { from: "user" }),
      ).rejects.toThrow("order[0] is invalid");
      await expect(
        program.parseAsync(
          [
            "workspaces",
            "widgets",
            "add",
            "--tab",
            "ops",
            "--kind",
            "builtin:markdown",
            "--grid",
            "bad",
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("grid must be x,y,w,h");
      await expect(
        program.parseAsync(["workspaces", "widgets", "update", "--tab", "ops", "--id", "missing"], {
          from: "user",
        }),
      ).rejects.toThrow("at least one patch option is required");
      await expect(
        program.parseAsync(
          [
            "workspaces",
            "widgets",
            "move",
            "--tab",
            "ops",
            "--id",
            "missing",
            "--grid",
            "0,0,4,2",
            "--to-tab",
            "ops",
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("not both");
      await expect(
        program.parseAsync(["workspaces", "widget-scaffold", "bad/name"], { from: "user" }),
      ).rejects.toThrow("widget name is invalid");
      await expect(
        program.parseAsync(["workspaces", "widget-scaffold", "."], { from: "user" }),
      ).rejects.toThrow("widget name is invalid");
    });
  });

  it("scaffolds operator widgets as pending and approves them through the approvals method", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      installGatewayMock(store);
      const program = createProgram(stateDir);

      await captureStdout(async () => {
        await program.parseAsync(
          ["workspaces", "widget-scaffold", "revenue-chart", "--title", "Revenue Chart"],
          { from: "user" },
        );
      });

      const widgetDir = path.join(stateDir, "workspaces", "widgets", "revenue-chart");
      const manifest = JSON.parse(await fs.readFile(path.join(widgetDir, "widget.json"), "utf8"));
      const html = await fs.readFile(path.join(widgetDir, "index.html"), "utf8");
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        name: "revenue-chart",
        title: "Revenue Chart",
        entrypoint: "index.html",
      });
      expect(html).toContain("workspace:ready");
      expect(html).toContain("workspace:getData");
      expect(html).toContain("function onData");
      expect(html).not.toMatch(/https?:\/\//);
      // An operator-scaffolded widget is pending too: the CLI cannot be a way to
      // mount agent-authored code without the approvals-scoped decision.
      expect(store.read().widgetsRegistry["revenue-chart"]).toEqual({
        status: "pending",
        createdBy: "user",
      });

      await captureStdout(async () => {
        await program.parseAsync(["workspaces", "widget-approve", "revenue-chart"], {
          from: "user",
        });
      });

      expect(store.read().widgetsRegistry["revenue-chart"]).toMatchObject({
        status: "approved",
        createdBy: "user",
        approvedBy: "user",
      });
    });
  });
});
