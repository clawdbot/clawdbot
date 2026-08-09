import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};
}

function payload(result: unknown): Payload {
  return asPayload(asPayload(result).details);
}

function cards(result: Payload): Payload[] {
  return Array.isArray(result.cards) ? result.cards.map(asPayload) : [];
}

function compact(card: Payload) {
  const latestProof = asPayload(card.latestProof);
  const diagnostics = Array.isArray(card.diagnostics)
    ? card.diagnostics
        .map((entry) => asPayload(entry).kind)
        .filter((kind): kind is string => typeof kind === "string")
    : [];
  return {
    status: card.status,
    acceptance: card.acceptance,
    diagnostics,
    latestProof: card.latestProof
      ? {
          status: latestProof.status,
          verification: latestProof.verification,
        }
      : undefined,
  };
}

describe("Workboard live proof evidence", () => {
  it("runs registered plugin tools through claim, review, and done on temporary SQLite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-live-proof-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    const store = new WorkboardStore(stores.cards, {
      boards: stores.boards,
      subscriptions: stores.subscriptions,
      attachments: stores.attachments,
    });
    let registeredTool: AnyAgentTool | OpenClawPluginToolFactory | undefined;
    const api = createTestPluginApi({
      id: "workboard",
      name: "Workboard",
      runtime: {
        sandbox: {
          resolveWorkspaceAuthority() {
            return { sandboxed: false, workspaceAccess: "rw" };
          },
        },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool(tool) {
        registeredTool = tool;
      },
    });
    const openSqlite = vi.spyOn(WorkboardStore, "openSqlite").mockReturnValue(store);

    try {
      plugin.register(api);
      if (typeof registeredTool !== "function") {
        throw new Error("Workboard plugin did not register its tool factory.");
      }
      const registered = registeredTool({
        agentId: "proof-agent",
        sessionKey: "redacted-session",
      });
      const toolList = Array.isArray(registered) ? registered : registered ? [registered] : [];
      const tools = new Map(toolList.map((tool) => [tool.name, tool]));

      const created = payload(
        await tools.get("workboard_create")?.execute("live-create", {
          title: "Live proof flow",
          status: "todo",
        }),
      );
      const cardId = asPayload(created.card).id as string;
      const claimed = payload(
        await tools.get("workboard_claim")?.execute("live-claim", { id: cardId }),
      );
      await tools.get("workboard_complete")?.execute("live-review", {
        id: cardId,
        token: claimed.token,
        status: "review",
        summary: "Live review handoff without proof.",
      });
      const reviewed = payload(
        await tools.get("workboard_list")?.execute("live-review-diagnostics", {
          refreshDiagnostics: true,
        }),
      );
      const reviewedCard = cards(reviewed).find((card) => card.status === "review") ?? {};
      const reClaimed = payload(
        await tools.get("workboard_claim")?.execute("live-reclaim", { id: cardId }),
      );
      const pendingProof = payload(
        await tools.get("workboard_proof")?.execute("live-proof", {
          id: cardId,
          status: "passed",
          verification: "worker_reported",
          command: "live sqlite Workboard proof flow",
          note: "Redacted disposable run.",
        }),
      );
      const proofAdded = payload(
        await tools.get("workboard_list")?.execute("live-proof-diagnostics", {
          refreshDiagnostics: true,
        }),
      );
      await tools.get("workboard_complete")?.execute("live-done", {
        id: cardId,
        token: reClaimed.token,
        status: "done",
        summary: "Live proof flow completed.",
        proofId: pendingProof.proofId,
        proof: {
          status: "passed",
          verification: "worker_reported",
          command: "live sqlite Workboard proof flow",
        },
      });

      const done = payload(
        await tools.get("workboard_list")?.execute("live-done-diagnostics", {
          refreshDiagnostics: true,
        }),
      );
      const doneCard = cards(done).find((card) => card.status === "done") ?? {};
      const evidence = {
        path: ["activated-plugin", "registered-tool-factory", "sqlite"],
        database: "temporary sqlite database",
        stages: [
          { stage: "claim", ...compact(asPayload(claimed.card)) },
          { stage: "review_without_proof", ...compact(reviewedCard) },
          {
            stage: "proof_added",
            ...compact(cards(proofAdded).find((card) => card.status === "review") ?? {}),
          },
          { stage: "done", ...compact(doneCard) },
        ],
      };
      expect(evidence).toMatchObject({
        path: ["activated-plugin", "registered-tool-factory", "sqlite"],
        stages: [
          { stage: "claim", status: "running" },
          { stage: "review_without_proof", status: "review", diagnostics: ["missing_proof"] },
          {
            stage: "proof_added",
            status: "review",
            diagnostics: [],
            latestProof: { status: "passed" },
          },
          {
            stage: "done",
            status: "done",
            acceptance: "manual_operator_acceptance",
            latestProof: { verification: "worker_reported" },
          },
        ],
      });
      const outputPath = process.env.WORKBOARD_LIVE_PROOF_OUTPUT;
      if (outputPath) {
        fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      }
    } finally {
      openSqlite.mockRestore();
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
