import { createReceiptStore } from "./src/store.js";

// Avoid depending on clawdbot/plugin-sdk so this extension can live as a reference
// without publishing/lockfile churn. The runtime will still pass the full API object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClawdbotPluginApi = any;

type Issue = { path: Array<string | number>; message: string };
type SafeParseResult =
  | { success: true; data?: unknown }
  | { success: false; error: { issues: Issue[] } };

function ok(data?: unknown): SafeParseResult {
  return { success: true, data };
}

function err(message: string, path: Array<string | number> = []): SafeParseResult {
  return { success: false, error: { issues: [{ path, message }] } };
}

const configSchema = {
  safeParse(value: unknown): SafeParseResult {
    if (value === undefined) return ok(undefined);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return err("expected config object");
    }

    const v = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    if ("enabled" in v) {
      if (typeof v.enabled !== "boolean") return err("enabled must be boolean", ["enabled"]);
      out.enabled = v.enabled;
    }

    if ("receiptsDir" in v) {
      if (typeof v.receiptsDir !== "string") return err("receiptsDir must be string", ["receiptsDir"]);
      out.receiptsDir = v.receiptsDir;
    }

    if ("includeParams" in v) {
      if (typeof v.includeParams !== "boolean") return err("includeParams must be boolean", ["includeParams"]);
      out.includeParams = v.includeParams;
    }

    return ok(out);
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      receiptsDir: { type: "string" },
      includeParams: { type: "boolean", default: true }
    }
  }
};

const plugin = {
  id: "action-receipts",
  name: "Action Receipts",
  description: "Record tool calls as local receipts for debugging and safety audits.",
  configSchema,
  register(api: ClawdbotPluginApi) {
    const store = createReceiptStore({ api });

    api.registerHook(["before_tool_call"], async (event: unknown, ctx: unknown) => {
      await store.onBeforeToolCall(event as any, ctx as any);
      return undefined;
    });

    api.registerHook(["after_tool_call"], async (event: unknown, ctx: unknown) => {
      await store.onAfterToolCall(event as any, ctx as any);
      return undefined;
    });

    api.registerCli((cli: any) => {
      cli.command(
        "receipts:list",
        "List recent action receipts",
        (yargs: any) =>
          yargs.option("limit", { type: "number", default: 20 }).option("session", {
            type: "string",
            describe: "Filter by session key"
          }),
        async (argv: any) => {
          const rows = await store.list({
            limit: argv.limit as number,
            sessionKey: argv.session ? String(argv.session) : undefined
          });
          for (const r of rows) {
            console.log(`${r.createdAt}\t${r.toolName}\t${r.sessionKey ?? ""}\t${r.id}`);
          }
        }
      );

      cli.command(
        "receipts:show <id>",
        "Show a specific receipt",
        (yargs: any) => yargs.positional("id", { type: "string", demandOption: true }),
        async (argv: any) => {
          const receipt = await store.read(String(argv.id));
          console.log(JSON.stringify(receipt, null, 2));
        }
      );
    });
  }
};

export default plugin;
