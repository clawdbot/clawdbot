import fs from "node:fs/promises";
import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  validateWorkspaceDoc,
  type WorkspaceBinding,
  type WorkspaceGrid,
  type WorkspaceTab,
  type WorkspaceWidget,
  type JsonValue,
  type WorkspaceDoc,
} from "./schema.js";

type JsonOptions = {
  json?: boolean;
};

type GatewayOptions = JsonOptions & {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

type RegisterWorkspaceCliOptions = {
  program: Command;
  stateDir?: string;
};

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${(error as Error).message}`, { cause: error });
  }
}

function parseOptionalBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid boolean: ${value}`);
}

function parseWorkspaceGrid(value: string): WorkspaceGrid {
  const parts = value.split(",").map((entry) => Number(entry.trim()));
  if (parts.length !== 4 || parts.some((entry) => !Number.isInteger(entry))) {
    throw new Error("grid must be x,y,w,h");
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}

export function parseWorkspaceBindingShorthand(value: string): [string, WorkspaceBinding] {
  const eqIndex = value.indexOf("=");
  if (eqIndex <= 0) {
    throw new Error("binding must be id=file:<path>, id=rpc:<method>, or id=static:<json>");
  }
  const id = value.slice(0, eqIndex).trim();
  const body = value.slice(eqIndex + 1).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw new Error("binding id is invalid");
  }
  if (body.startsWith("file:")) {
    const fileSpec = body.slice("file:".length);
    const hashIndex = fileSpec.indexOf("#");
    const bindingPath = hashIndex >= 0 ? fileSpec.slice(0, hashIndex) : fileSpec;
    const pointer = hashIndex >= 0 ? fileSpec.slice(hashIndex + 1) : undefined;
    if (!bindingPath) {
      throw new Error("file binding path is required");
    }
    return [
      id,
      {
        source: "file",
        path: bindingPath,
        ...(pointer !== undefined ? { pointer } : {}),
      },
    ];
  }
  if (body.startsWith("rpc:")) {
    const method = body.slice("rpc:".length).trim();
    if (!method) {
      throw new Error("rpc binding method is required");
    }
    return [id, { source: "rpc", method }];
  }
  if (body.startsWith("static:")) {
    return [id, { source: "static", value: parseJson(body.slice("static:".length), "static") }];
  }
  throw new Error("binding source must be file, rpc, or static");
}

function collectBinding(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseBindings(values: string[] | undefined): Record<string, WorkspaceBinding> | undefined {
  if (!values?.length) {
    return undefined;
  }
  return Object.fromEntries(values.map(parseWorkspaceBindingShorthand));
}

async function callWorkspaceGateway(
  method: string,
  options: GatewayOptions,
  params?: unknown,
): Promise<unknown> {
  // `workspaces.widget.approve` is the only approvals-scoped method here: approving
  // agent-authored widget code is a separate decision from editing a layout, so the
  // connection asks for that scope only when it is about to make it.
  // Match `src/gateway/operator-approvals-client.ts`: ask for the approvals scope
  // alone. A paired device approves scope sets, so requesting a superset here is
  // rejected as "asking for more scopes than currently approved".
  const scopes =
    method === "workspaces.widget.approve"
      ? (["operator.approvals"] as const)
      : (["operator.write", "operator.read"] as const);
  return await callGatewayFromCli(method, options, params, { mode: "cli", scopes: [...scopes] });
}

function readWorkspaceResult(value: unknown): { doc: WorkspaceDoc; workspaceVersion: number } {
  if (!isRecord(value)) {
    throw new Error("workspace gateway response must be an object");
  }
  const doc = validateWorkspaceDoc(value.doc);
  return {
    doc,
    workspaceVersion:
      typeof value.workspaceVersion === "number" ? value.workspaceVersion : doc.workspaceVersion,
  };
}

async function readWorkspace(options: GatewayOptions): Promise<WorkspaceDoc> {
  return readWorkspaceResult(await callWorkspaceGateway("workspaces.get", options)).doc;
}

function orderedTabs(doc: WorkspaceDoc): WorkspaceTab[] {
  const bySlug = new Map(doc.tabs.map((tab) => [tab.slug, tab]));
  const ordered = doc.prefs.tabOrder.flatMap((slug) => {
    const tab = bySlug.get(slug);
    return tab ? [tab] : [];
  });
  const seen = new Set(ordered.map((tab) => tab.slug));
  return [...ordered, ...doc.tabs.filter((tab) => !seen.has(tab.slug))];
}

function formatTabLine(tab: WorkspaceTab): string {
  const hidden = tab.hidden ? "hidden" : "visible";
  return `${tab.slug.padEnd(18)} ${hidden.padEnd(8)} ${tab.title}`;
}

function formatWidgetLine(tab: string, widget: WorkspaceWidget): string {
  const grid = `${widget.grid.x},${widget.grid.y},${widget.grid.w},${widget.grid.h}`;
  const state = [widget.hidden ? "hidden" : "visible", widget.collapsed ? "collapsed" : ""]
    .filter(Boolean)
    .join(",");
  return `${tab.padEnd(14)} ${widget.id.padEnd(18)} ${widget.kind.padEnd(20)} ${grid.padEnd(9)} ${state.padEnd(10)} ${widget.title ?? ""}`;
}

function writeTabs(doc: WorkspaceDoc, options: JsonOptions): void {
  const tabs = orderedTabs(doc);
  if (options.json) {
    writeJson({ tabs });
    return;
  }
  for (const tab of tabs) {
    writeLine(formatTabLine(tab));
  }
}

function widgetRows(
  doc: WorkspaceDoc,
  tabSlug?: string,
): Array<{ tab: string; widget: WorkspaceWidget }> {
  const tabs = tabSlug ? doc.tabs.filter((tab) => tab.slug === tabSlug) : orderedTabs(doc);
  if (tabSlug && tabs.length === 0) {
    throw new Error(`workspace tab not found: ${tabSlug}`);
  }
  return tabs.flatMap((tab) => tab.widgets.map((widget) => ({ tab: tab.slug, widget })));
}

function writeWidgets(doc: WorkspaceDoc, options: JsonOptions & { tab?: string }): void {
  const widgets = widgetRows(doc, options.tab);
  if (options.json) {
    writeJson({ widgets: widgets.map(({ tab, widget }) => ({ tab, ...widget })) });
    return;
  }
  for (const { tab, widget } of widgets) {
    writeLine(formatWidgetLine(tab, widget));
  }
}

function requirePatch(patch: Record<string, unknown>): void {
  if (Object.keys(patch).length === 0) {
    throw new Error("at least one patch option is required");
  }
}

function addGatewayOptions(command: Command): Command {
  return addGatewayClientOptions(command);
}

export function registerWorkspaceCli(options: RegisterWorkspaceCliOptions): void {
  const workspace = options.program
    .command("workspaces")
    .description("Manage Workspaces tabs and widgets");
  const tabs = workspace.command("tabs").description("Manage workspace tabs");
  const widgets = workspace.command("widgets").description("Manage workspace widgets");
  const layout = workspace.command("layout").description("Manage workspace layout documents");

  addGatewayOptions(
    tabs.command("list").description("List workspace tabs").option("--json", "Print JSON", false),
  ).action(async (commandOptions: GatewayOptions) => {
    writeTabs(await readWorkspace(commandOptions), commandOptions);
  });

  addGatewayOptions(
    tabs
      .command("create")
      .description("Create a workspace tab")
      .requiredOption("--title <title>", "Tab title")
      .option("--slug <slug>", "Tab slug")
      .option("--icon <icon>", "Icon name"),
  ).action(
    async (commandOptions: GatewayOptions & { title: string; slug?: string; icon?: string }) => {
      const result = await callWorkspaceGateway("workspaces.tab.create", commandOptions, {
        title: commandOptions.title,
        ...(commandOptions.slug ? { slug: commandOptions.slug } : {}),
        ...(commandOptions.icon ? { icon: commandOptions.icon } : {}),
      });
      writeTabs(readWorkspaceResult(result).doc, commandOptions);
    },
  );

  addGatewayOptions(
    tabs.command("delete").argument("<slug>", "Tab slug").description("Delete a workspace tab"),
  ).action(async (slug: string, commandOptions: GatewayOptions) => {
    const result = await callWorkspaceGateway("workspaces.tab.delete", commandOptions, {
      slug,
    });
    writeTabs(readWorkspaceResult(result).doc, commandOptions);
  });

  addGatewayOptions(
    tabs
      .command("reorder")
      .argument("<slug...>", "Tab slugs")
      .description("Set workspace tab order"),
  ).action(async (order: string[], commandOptions: GatewayOptions) => {
    const result = await callWorkspaceGateway("workspaces.tab.reorder", commandOptions, {
      order,
    });
    writeTabs(readWorkspaceResult(result).doc, commandOptions);
  });

  for (const [verb, hidden] of [
    ["hide", true],
    ["show", false],
  ] as const) {
    addGatewayOptions(
      tabs.command(verb).argument("<slug>", "Tab slug").description(`${verb} a workspace tab`),
    ).action(async (slug: string, commandOptions: GatewayOptions) => {
      const result = await callWorkspaceGateway("workspaces.tab.update", commandOptions, {
        slug,
        patch: { hidden },
      });
      writeTabs(readWorkspaceResult(result).doc, commandOptions);
    });
  }

  addGatewayOptions(
    widgets
      .command("list")
      .description("List workspace widgets")
      .option("--tab <slug>", "Tab slug")
      .option("--json", "Print JSON", false),
  ).action(async (commandOptions: GatewayOptions & { tab?: string }) => {
    writeWidgets(await readWorkspace(commandOptions), commandOptions);
  });

  addGatewayOptions(
    widgets
      .command("add")
      .description("Add a workspace widget")
      .requiredOption("--tab <slug>", "Tab slug")
      .requiredOption("--kind <kind>", "Widget kind")
      .option("--id <id>", "Widget id")
      .option("--title <title>", "Widget title")
      .option("--grid <x,y,w,h>", "Widget grid", "0,0,4,2")
      .option("--binding <id=source>", "Binding shorthand", collectBinding, [])
      .option("--props <json>", "Widget props JSON"),
  ).action(
    async (
      commandOptions: GatewayOptions & {
        tab: string;
        id?: string;
        kind: string;
        title?: string;
        grid?: string;
        binding?: string[];
        props?: string;
      },
    ) => {
      const bindings = parseBindings(commandOptions.binding);
      const result = await callWorkspaceGateway("workspaces.widget.add", commandOptions, {
        tab: commandOptions.tab,
        widget: {
          ...(commandOptions.id ? { id: commandOptions.id } : {}),
          kind: commandOptions.kind,
          ...(commandOptions.title ? { title: commandOptions.title } : {}),
          grid: parseWorkspaceGrid(commandOptions.grid ?? "0,0,4,2"),
          ...(bindings ? { bindings } : {}),
          ...(commandOptions.props ? { props: parseJson(commandOptions.props, "props") } : {}),
        },
      });
      writeWidgets(readWorkspaceResult(result).doc, { ...commandOptions, tab: commandOptions.tab });
    },
  );

  addGatewayOptions(
    widgets
      .command("update")
      .description("Update a workspace widget")
      .requiredOption("--tab <slug>", "Tab slug")
      .requiredOption("--id <id>", "Widget id")
      .option("--title <title>", "Widget title")
      .option("--collapsed <bool>", "Collapsed state", parseOptionalBoolean)
      .option("--hidden <bool>", "Hidden state", parseOptionalBoolean),
  ).action(
    async (
      commandOptions: GatewayOptions & {
        tab: string;
        id: string;
        title?: string;
        collapsed?: boolean;
        hidden?: boolean;
      },
    ) => {
      const patch = {
        ...(commandOptions.title !== undefined ? { title: commandOptions.title } : {}),
        ...(commandOptions.collapsed !== undefined ? { collapsed: commandOptions.collapsed } : {}),
        ...(commandOptions.hidden !== undefined ? { hidden: commandOptions.hidden } : {}),
      };
      requirePatch(patch);
      const result = await callWorkspaceGateway("workspaces.widget.update", commandOptions, {
        tab: commandOptions.tab,
        id: commandOptions.id,
        patch,
      });
      writeWidgets(readWorkspaceResult(result).doc, { ...commandOptions, tab: commandOptions.tab });
    },
  );

  addGatewayOptions(
    widgets
      .command("move")
      .description("Move a workspace widget")
      .option("--tab <slug>", "Current tab slug")
      .requiredOption("--id <id>", "Widget id")
      .option("--grid <x,y,w,h>", "New grid")
      .option("--to-tab <slug>", "Destination tab slug"),
  ).action(
    async (
      commandOptions: GatewayOptions & { tab?: string; id: string; grid?: string; toTab?: string },
    ) => {
      const result = await callWorkspaceGateway("workspaces.widget.move", commandOptions, {
        ...(commandOptions.tab ? { tab: commandOptions.tab } : {}),
        id: commandOptions.id,
        ...(commandOptions.grid ? { grid: parseWorkspaceGrid(commandOptions.grid) } : {}),
        ...(commandOptions.toTab ? { toTab: commandOptions.toTab } : {}),
      });
      writeWidgets(readWorkspaceResult(result).doc, { ...commandOptions, tab: commandOptions.tab });
    },
  );

  addGatewayOptions(
    widgets
      .command("remove")
      .description("Remove a workspace widget")
      .requiredOption("--tab <slug>", "Tab slug")
      .requiredOption("--id <id>", "Widget id"),
  ).action(async (commandOptions: GatewayOptions & { tab: string; id: string }) => {
    const result = await callWorkspaceGateway("workspaces.widget.remove", commandOptions, {
      tab: commandOptions.tab,
      id: commandOptions.id,
    });
    writeWidgets(readWorkspaceResult(result).doc, { ...commandOptions, tab: commandOptions.tab });
  });

  addGatewayOptions(
    layout
      .command("get")
      .description("Read the Workspaces layout")
      .option("--json", "Print JSON", false),
  ).action(async (commandOptions: GatewayOptions) => {
    const doc = await readWorkspace(commandOptions);
    if (commandOptions.json) {
      writeJson({ doc, workspaceVersion: doc.workspaceVersion });
    } else {
      writeLine(`workspaceVersion ${doc.workspaceVersion}`);
      writeTabs(doc, commandOptions);
    }
  });

  addGatewayOptions(
    layout
      .command("set")
      .description("Replace the Workspaces layout")
      .requiredOption("--file <path>", "Workspace JSON file"),
  ).action(async (commandOptions: GatewayOptions & { file: string }) => {
    const doc = validateWorkspaceDoc(JSON.parse(await fs.readFile(commandOptions.file, "utf8")));
    const result = await callWorkspaceGateway("workspaces.replace", commandOptions, {
      doc,
    });
    const next = readWorkspaceResult(result);
    if (commandOptions.json) {
      writeJson(next);
    } else {
      writeLine(`workspaceVersion ${next.workspaceVersion}`);
    }
  });

  addGatewayOptions(
    layout.command("undo").description("Restore the newest workspace undo snapshot"),
  ).action(async (commandOptions: GatewayOptions) => {
    const result = await callWorkspaceGateway("workspaces.undo", commandOptions, {});
    const next = readWorkspaceResult(result);
    if (commandOptions.json) {
      writeJson(next);
    } else {
      writeLine(`workspaceVersion ${next.workspaceVersion}`);
    }
  });

  addGatewayOptions(
    workspace
      .command("widget-scaffold")
      .argument("<name>", "Custom widget name")
      .description("Create a custom widget scaffold (starts pending approval)")
      .option("--title <title>", "Widget title"),
  ).action(async (name: string, commandOptions: GatewayOptions & { title?: string }) => {
    const result = await callWorkspaceGateway("workspaces.widget.scaffold", commandOptions, {
      name,
      ...(commandOptions.title !== undefined ? { title: commandOptions.title } : {}),
    });
    if (commandOptions.json) {
      writeJson(result);
      return;
    }
    const dir = isRecord(result) && typeof result.dir === "string" ? result.dir : name;
    writeLine(`created ${dir}`);
    writeLine(`pending approval; run: openclaw workspaces widget-approve ${name}`);
  });

  addGatewayOptions(
    workspace
      .command("widget-approve")
      .argument("<name>", "Custom widget name")
      .description("Approve or reject a pending custom widget")
      .option("--reject", "Reject instead of approving"),
  ).action(async (name: string, commandOptions: GatewayOptions & { reject?: boolean }) => {
    const decision = commandOptions.reject ? "rejected" : "approved";
    // Approve responds with the registry entry only: the approvals scope is not a
    // door onto the workspace document.
    const result = await callWorkspaceGateway("workspaces.widget.approve", commandOptions, {
      name,
      decision,
    });
    if (commandOptions.json) {
      writeJson(result);
    } else {
      writeLine(`${name} ${decision}`);
    }
  });
}
