import type { Command } from "commander";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { addGatewayClientOptions, callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveWorkboardCardByIdOrPrefix } from "./card-lookup.js";
import type { WorkboardDispatchResult, WorkboardStore } from "./store.js";
import type { WorkboardCard } from "./types.js";

type JsonOptions = {
  json?: boolean;
};

type GatewayOptions = JsonOptions & {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function splitLabels(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatCardLine(card: WorkboardCard): string {
  const boardId = card.metadata?.automation?.boardId ?? "default";
  const agent = card.agentId ? ` ${card.agentId}` : "";
  return `${card.id.slice(0, 8)}  ${card.status.padEnd(8)}  ${card.priority.padEnd(6)}  ${boardId}${agent}  ${card.title}`;
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: {
        ...claim,
        token: "[redacted]",
      },
    },
  };
}

function redactDispatchResult(result: WorkboardDispatchResult): WorkboardDispatchResult {
  return {
    ...result,
    promoted: result.promoted.map(redactClaimToken),
    reclaimed: result.reclaimed.map(redactClaimToken),
    blocked: result.blocked.map(redactClaimToken),
    orchestrated: result.orchestrated.map(redactClaimToken),
  };
}

function writeCards(cards: WorkboardCard[], options: JsonOptions): void {
  if (options.json) {
    writeJson({ cards: cards.map(redactClaimToken) });
    return;
  }
  for (const card of cards) {
    writeLine(formatCardLine(card));
  }
}

async function callWorkboardGateway(
  method: string,
  options: GatewayOptions,
  params?: unknown,
): Promise<unknown> {
  return await callGatewayFromCli(method, options, params, {
    mode: "cli",
    scopes: ["operator.write", "operator.read"],
  });
}

function isGatewayUnavailableError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return [
    "econnrefused",
    "econnreset",
    "ehostunreach",
    "enotfound",
    "gateway not connected",
    "gateway unavailable",
    "unknown method: workboard.cards.dispatch",
  ].some((marker) => message.includes(marker));
}

function hasExplicitGatewayTarget(options: GatewayOptions): boolean {
  return Boolean(options.url?.trim() || options.token?.trim());
}

function hasConfiguredRemoteGatewayTarget(): boolean {
  if (process.env.OPENCLAW_GATEWAY_URL?.trim()) {
    return true;
  }
  try {
    return getRuntimeConfig().gateway?.mode === "remote";
  } catch {
    return false;
  }
}

export function registerWorkboardCli(params: { program: Command; store: WorkboardStore }): void {
  const workboard = params.program
    .command("workboard")
    .description("Manage Workboard cards and worker dispatch");

  workboard
    .command("list")
    .description("List Workboard cards")
    .option("--board <id>", "Board id")
    .option("--status <status>", "Filter by status")
    .option("--json", "Print JSON", false)
    .action(async (options: JsonOptions & { board?: string; status?: string }) => {
      let cards = await params.store.list({ boardId: options.board });
      if (options.status) {
        cards = cards.filter((card) => card.status === options.status);
      }
      writeCards(cards, options);
    });

  workboard
    .command("create")
    .argument("<title...>", "Card title")
    .description("Create a Workboard card")
    .option("--notes <text>", "Card notes")
    .option("--status <status>", "Initial status", "todo")
    .option("--priority <priority>", "Priority", "normal")
    .option("--agent <id>", "Assigned agent id")
    .option("--board <id>", "Board id")
    .option("--labels <items>", "Comma-separated labels")
    .option("--json", "Print JSON", false)
    .action(
      async (
        title: string[],
        options: JsonOptions & {
          notes?: string;
          status?: string;
          priority?: string;
          agent?: string;
          board?: string;
          labels?: string;
        },
      ) => {
        const card = await params.store.create({
          title: title.join(" "),
          notes: options.notes,
          status: options.status,
          priority: options.priority,
          agentId: options.agent,
          boardId: options.board,
          labels: splitLabels(options.labels),
        });
        if (options.json) {
          writeJson({ card: redactClaimToken(card) });
        } else {
          writeLine(formatCardLine(card));
        }
      },
    );

  workboard
    .command("show")
    .argument("<id>", "Card id or prefix")
    .description("Show one Workboard card")
    .option("--json", "Print JSON", false)
    .action(async (id: string, options: JsonOptions) => {
      const cards = await params.store.list();
      const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
      if (!card) {
        throw new Error(error);
      }
      if (options.json) {
        writeJson({ card: redactClaimToken(card) });
      } else {
        writeLine(formatCardLine(card));
        if (card.notes) {
          writeLine(card.notes);
        }
      }
    });

  addGatewayClientOptions(
    workboard
      .command("dispatch")
      .description("Promote ready cards and start worker runs through the Gateway")
      .option("--json", "Print JSON", false),
  ).action(async (options: GatewayOptions) => {
    try {
      const result = await callWorkboardGateway("workboard.cards.dispatch", options, {});
      if (options.json) {
        writeJson(result);
      } else {
        const record = isRecord(result) ? result : {};
        const started = Array.isArray(record.started) ? record.started.length : 0;
        const failures = Array.isArray(record.startFailures) ? record.startFailures.length : 0;
        writeLine(`dispatch complete: started=${started} failures=${failures}`);
      }
    } catch (error) {
      if (
        !isGatewayUnavailableError(error) ||
        hasExplicitGatewayTarget(options) ||
        hasConfiguredRemoteGatewayTarget()
      ) {
        throw error;
      }
      const result = redactDispatchResult(await params.store.dispatch());
      if (options.json) {
        writeJson({ ...result, gatewayUnavailable: true });
      } else {
        writeLine(
          `gateway unavailable; data dispatch only: promoted=${result.promoted.length} blocked=${result.blocked.length}`,
        );
      }
    }
  });
}
