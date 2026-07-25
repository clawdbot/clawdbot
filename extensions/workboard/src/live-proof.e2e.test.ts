import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

type Payload = Record<string, any>;

function payload(result: unknown): Payload {
  return (result as { details?: Payload }).details ?? {};
}

function compact(card: Payload) {
  return {
    status: card.status,
    acceptance: card.acceptance,
    diagnostics: (card.diagnostics ?? []).map((entry: Payload) => entry.kind),
    latestProof: card.latestProof
      ? {
          status: card.latestProof.status,
          verification: card.latestProof.verification,
        }
      : undefined,
  };
}

describe("Workboard live proof evidence", () => {
  it("runs claim through review and done on a real temporary sqlite store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-live-proof-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    const store = new WorkboardStore(stores.cards, {
      boards: stores.boards,
      subscriptions: stores.subscriptions,
      attachments: stores.attachments,
    });
    const tools = new Map(
      createWorkboardTools({
        api: { runtime: {} } as never,
        store,
        context: { agentId: "proof-agent", sessionKey: "redacted-session" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    try {
      const created = payload(
        await tools.get("workboard_create")?.execute("live-create", {
          title: "Live proof flow",
          status: "todo",
        }),
      );
      const cardId = created.card.id as string;
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
      const reviewedCard = reviewed.cards.find((card: Payload) => card.status === "review");
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
      const doneCard = done.cards.find((card: Payload) => card.status === "done");
      const evidence = {
        database: "temporary sqlite database",
        stages: [
          { stage: "claim", ...compact(claimed.card) },
          { stage: "review_without_proof", ...compact(reviewedCard) },
          {
            stage: "proof_added",
            ...compact(proofAdded.cards.find((card: Payload) => card.status === "review")),
          },
          { stage: "done", ...compact(doneCard) },
        ],
      };
      expect(evidence.stages).toMatchObject([
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
      ]);
      const outputPath = process.env.WORKBOARD_LIVE_PROOF_OUTPUT;
      if (outputPath) {
        fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      }
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
