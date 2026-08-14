// Delivery failure CLI behavior tests protect redaction and fence-safe purge semantics.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  moveDeliveryQueueEntryToFailed,
  upsertDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import type { DeliveryQueueTerminalPolicy } from "../infra/delivery-queue-sqlite.types.js";
import type { DeliveryQueueEntryState } from "../infra/delivery-queue-sqlite.types.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-media-staging.js";
import { enqueueDelivery } from "../infra/outbound/delivery-queue-storage.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  deliveryFailuresListCommand,
  deliveryFailuresPurgeCommand,
  deliveryFailuresResubmitCommand,
} from "./delivery-failures.js";

const gatewayMocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCli: gatewayMocks.call }));

const permanentPolicy: DeliveryQueueTerminalPolicy = {
  version: 1,
  detail: "full",
  replay: "safe",
  fence: { kind: "permanent" },
  reason: "retry_exhausted",
  payload: "present",
  cleanup: "complete",
  evidence: "pre_side_effect",
};

describe("delivery failures commands", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    gatewayMocks.call.mockReset();
  });

  function readJsonLog(runtime: { log: ReturnType<typeof vi.fn> }) {
    return JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  }

  it("lists bounded metadata with fingerprinted identifiers and no retained content", async () => {
    await withTestDir({ prefix: "openclaw-delivery-cli-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const id = "route:private:stable-id";
      const producerPolicy: DeliveryQueueTerminalPolicy = {
        ...permanentPolicy,
        fence: {
          kind: "producer-bounded",
          idPrefix: "route:private:",
          maxAgeMs: 60_000,
          maxEntries: 25,
        },
      };
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 3,
          sessionKey: "agent:main:private",
          text: "sensitive payload",
          terminalPolicy: producerPolicy,
        } as DeliveryQueueEntryState & { sessionKey: string; text: string },
      });
      moveDeliveryQueueEntryToFailed("session", id, producerPolicy);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      deliveryFailuresListCommand({ json: true, limit: 500 }, runtime);
      const redacted = String(runtime.log.mock.calls[0]?.[0]);
      expect(redacted).toContain("sha256:");
      expect(redacted).not.toContain(id);
      expect(redacted).not.toContain("sensitive payload");
      expect(redacted).not.toContain("agent:main:private");
      const defaultJson = readJsonLog(runtime) as {
        failures: Array<{ fence: Record<string, unknown> }>;
      };
      expect(defaultJson.failures[0]?.fence).toMatchObject({
        kind: "producer-bounded",
        maxAgeMs: 60_000,
        maxEntries: 25,
        idPrefixFingerprint: expect.stringContaining("sha256:"),
      });
      expect(defaultJson.failures[0]?.fence).not.toHaveProperty("idPrefix");

      runtime.log.mockClear();
      deliveryFailuresListCommand({ limit: 1 }, runtime);
      const human = String(runtime.log.mock.calls[0]?.[0]);
      expect(human).toContain("maxAgeMs=60000 maxEntries=25");
      expect(human).toContain("idPrefixFingerprint=sha256:");
      expect(human).not.toContain("route:private:");

      runtime.log.mockClear();
      deliveryFailuresListCommand({ json: true, exactIds: true, limit: 1 }, runtime);
      const exactJson = readJsonLog(runtime) as {
        failures: Array<{ id: string; fence: Record<string, unknown> }>;
      };
      expect(exactJson.failures[0]).toMatchObject({
        id,
        fence: { idPrefix: "route:private:" },
      });
      expect(exactJson.failures[0]?.fence).not.toHaveProperty("idPrefixFingerprint");

      runtime.log.mockClear();
      deliveryFailuresListCommand({ exactIds: true, limit: 1 }, runtime);
      expect(String(runtime.log.mock.calls[0]?.[0])).toContain("idPrefix=route:private:");
    });
  });

  it("keeps purge dry by default and compacts permanent fences without deleting them", async () => {
    await withTestDir({ prefix: "openclaw-delivery-purge-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const id = "permanent:failure";
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 1,
          sessionKey: "agent:main:private",
          text: "sensitive payload",
          terminalPolicy: permanentPolicy,
        } as DeliveryQueueEntryState & { sessionKey: string; text: string },
      });
      moveDeliveryQueueEntryToFailed("session", id, permanentPolicy);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await deliveryFailuresPurgeCommand({ json: true }, runtime);
      let row = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status, session_key, entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
        )
        .get(id) as Record<string, unknown>;
      expect(row.session_key).toBe("agent:main:private");

      await deliveryFailuresPurgeCommand({ json: true, apply: true, yes: true }, runtime);
      row = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status, session_key, entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
        )
        .get(id) as Record<string, unknown>;
      expect(row.status).toBe("failed");
      expect(row.session_key).toBeNull();
      expect(String(row.entry_json)).not.toContain("sensitive payload");
      expect(JSON.parse(String(row.entry_json))).toMatchObject({
        terminalPolicy: { detail: "compacted", fence: { kind: "permanent" } },
      });
    });
  });

  it("applies the exact queue- and limit-scoped dry-run plan", async () => {
    await withTestDir({ prefix: "openclaw-delivery-purge-plan-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const seed = (queueName: string, id: string, failedAt: number) => {
        upsertDeliveryQueueEntry({
          queueName,
          entry: {
            id,
            enqueuedAt: failedAt,
            retryCount: 1,
            sessionKey: `session:${id}`,
            text: `payload:${id}`,
            terminalPolicy: permanentPolicy,
          } as DeliveryQueueEntryState & { sessionKey: string; text: string },
        });
        moveDeliveryQueueEntryToFailed(queueName, id, permanentPolicy);
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE delivery_queue_entries SET failed_at = ? WHERE queue_name = ? AND id = ?",
          )
          .run(failedAt, queueName, id);
      };
      seed("session", "session-new", 300);
      seed("session", "session-old", 200);
      seed("outbound-prepared-v1", "outbound-new", 400);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await deliveryFailuresPurgeCommand({ queue: "session", limit: 1, json: true }, runtime);
      const dryRun = readJsonLog(runtime);
      expect(dryRun).toMatchObject({
        applied: false,
        scanned: 1,
        compacted: 1,
        deleted: 0,
        errors: 0,
      });

      await deliveryFailuresPurgeCommand(
        { queue: "session", limit: 1, json: true, apply: true, yes: true },
        runtime,
      );
      const applied = readJsonLog(runtime);
      expect(applied).toMatchObject({
        applied: true,
        scanned: dryRun.scanned,
        compacted: dryRun.compacted,
        deleted: dryRun.deleted,
        errors: 0,
      });
      const rows = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT queue_name, id, recovery_state FROM delivery_queue_entries ORDER BY queue_name, id",
        )
        .all();
      expect(rows).toEqual([
        { queue_name: "outbound-prepared-v1", id: "outbound-new", recovery_state: null },
        { queue_name: "session", id: "session-new", recovery_state: "failed_terminal_v1" },
        { queue_name: "session", id: "session-old", recovery_state: null },
      ]);
    });
  });

  it("reports and applies the same eligible deletion plan", async () => {
    await withTestDir({ prefix: "openclaw-delivery-purge-delete-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const policy: DeliveryQueueTerminalPolicy = {
        ...permanentPolicy,
        replay: "ambiguous",
        fence: { kind: "none" },
        evidence: "unknown_after_send",
      };
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          id: "delete-me",
          enqueuedAt: 1,
          retryCount: 1,
          terminalPolicy: policy,
        },
      });
      moveDeliveryQueueEntryToFailed("session", "delete-me", policy);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await deliveryFailuresPurgeCommand({ queue: "session", json: true }, runtime);
      const dryRun = readJsonLog(runtime);
      expect(dryRun).toMatchObject({ scanned: 1, compacted: 0, deleted: 1 });
      await deliveryFailuresPurgeCommand(
        { queue: "session", json: true, apply: true, yes: true },
        runtime,
      );
      expect(readJsonLog(runtime)).toMatchObject({
        scanned: 1,
        compacted: dryRun.compacted,
        deleted: dryRun.deleted,
        errors: 0,
      });
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT id FROM delivery_queue_entries WHERE id = 'delete-me'")
          .get(),
      ).toBeUndefined();
    });
  });

  it("releases exact outbound spool artifacts only after purge delete or compaction commits", async () => {
    await withTestDir({ prefix: "openclaw-delivery-purge-media-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const seed = async (
        artifactName: string,
        policy: DeliveryQueueTerminalPolicy,
        failedAt: number,
      ) => {
        const artifact = path.join(stateDir, "delivery-queue-media", artifactName);
        await fs.mkdir(path.dirname(artifact), { recursive: true });
        await fs.writeFile(artifact, "private-media");
        const id = await enqueueDelivery({
          channel: "workspace",
          to: "#private",
          payloads: [{ mediaUrl: artifact }],
        });
        moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, policy);
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE delivery_queue_entries SET failed_at = ? WHERE queue_name = ? AND id = ?",
          )
          .run(failedAt, OUTBOUND_DELIVERY_QUEUE_NAME, id);
        return { artifact, id };
      };
      const expired = await seed(
        "00000000-0000-4000-8000-000000000061.bin",
        { ...permanentPolicy, fence: { kind: "none" } },
        1,
      );
      const fenced = await seed(
        "00000000-0000-4000-8000-000000000062.bin",
        permanentPolicy,
        Date.now(),
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await deliveryFailuresPurgeCommand(
        { queue: OUTBOUND_DELIVERY_QUEUE_NAME, json: true },
        runtime,
      );
      await expect(fs.stat(expired.artifact)).resolves.toBeDefined();
      await expect(fs.stat(fenced.artifact)).resolves.toBeDefined();

      await deliveryFailuresPurgeCommand(
        {
          queue: OUTBOUND_DELIVERY_QUEUE_NAME,
          json: true,
          apply: true,
          yes: true,
        },
        runtime,
      );

      expect(readJsonLog(runtime)).toMatchObject({ deleted: 1, compacted: 1, errors: 0 });
      await expect(fs.stat(expired.artifact)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(fenced.artifact)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT id FROM delivery_queue_entries WHERE id = ?")
          .get(expired.id),
      ).toBeUndefined();
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status, recovery_state FROM delivery_queue_entries WHERE id = ?")
          .get(fenced.id),
      ).toEqual({ status: "failed", recovery_state: "failed_terminal_v1" });
    });
  });

  it("does not release outbound media when the purge CAS fails", async () => {
    await withTestDir({ prefix: "openclaw-delivery-purge-media-cas-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const artifact = path.join(
        stateDir,
        "delivery-queue-media",
        "00000000-0000-4000-8000-000000000063.bin",
      );
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, "still-owned-media");
      const id = await enqueueDelivery({
        channel: "workspace",
        to: "#private",
        payloads: [{ mediaUrl: artifact }],
      });
      moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, permanentPolicy);
      openOpenClawStateDatabase().db.exec(`CREATE TRIGGER reject_purge_compaction
        BEFORE UPDATE ON delivery_queue_entries WHEN OLD.id = '${id}'
        BEGIN SELECT RAISE(ABORT, 'purge CAS rejected'); END`);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await deliveryFailuresPurgeCommand(
        {
          queue: OUTBOUND_DELIVERY_QUEUE_NAME,
          json: true,
          apply: true,
          yes: true,
        },
        runtime,
      );

      expect(readJsonLog(runtime)).toMatchObject({ compacted: 0, deleted: 0, errors: 1 });
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("cleanup errors"));
      expect(runtime.exit).toHaveBeenCalledWith(1);
      await expect(fs.readFile(artifact, "utf8")).resolves.toBe("still-owned-media");
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status, recovery_state FROM delivery_queue_entries WHERE id = ?")
          .get(id),
      ).toEqual({ status: "failed", recovery_state: null });
    });
  });

  it("routes resubmit through Gateway without mutating local failed storage", async () => {
    await withTestDir({ prefix: "openclaw-delivery-resubmit-cli-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const id = "route:private:operator-resubmit";
      const safePolicy: DeliveryQueueTerminalPolicy = {
        ...permanentPolicy,
        fence: { kind: "none" },
      };
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          id,
          kind: "systemEvent",
          sessionKey: "agent:main:private",
          text: "sensitive payload",
          enqueuedAt: Date.now(),
          retryCount: 1,
          terminalPolicy: safePolicy,
        } as DeliveryQueueEntryState & {
          kind: "systemEvent";
          sessionKey: string;
          text: string;
        },
      });
      moveDeliveryQueueEntryToFailed("session", id, safePolicy);
      gatewayMocks.call.mockResolvedValue({
        ok: true,
        queueName: "session",
        disposition: "scheduled",
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await deliveryFailuresResubmitCommand(
        id,
        {
          queue: "session",
          url: "ws://127.0.0.1:18789",
          token: "test-token",
          timeout: "5000",
          json: true,
        },
        runtime,
      );

      expect(gatewayMocks.call).toHaveBeenCalledWith(
        "delivery.failures.resubmit",
        {
          url: "ws://127.0.0.1:18789",
          token: "test-token",
          timeout: "5000",
          json: true,
        },
        { id, queueName: "session" },
        { scopes: ["operator.admin"] },
      );
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT status FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?",
          )
          .get(id),
      ).toEqual({ status: "failed" });
      const output = String(runtime.log.mock.calls.at(-1)?.[0]);
      expect(output).toContain("sha256:");
      expect(output).not.toContain(id);
      expect(output).not.toContain("sensitive payload");

      runtime.log.mockClear();
      await deliveryFailuresResubmitCommand(id, { queue: "session", exactIds: true }, runtime);
      expect(String(runtime.log.mock.calls.at(-1)?.[0])).toContain(id);
    });
  });

  it("leaves failed storage unchanged when Gateway is unavailable", async () => {
    await withTestDir({ prefix: "openclaw-delivery-resubmit-cli-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const id = "gateway-unavailable-resubmit";
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: { id, enqueuedAt: Date.now(), retryCount: 1, terminalPolicy: permanentPolicy },
      });
      moveDeliveryQueueEntryToFailed("session", id, permanentPolicy);
      gatewayMocks.call.mockRejectedValue(new Error("Gateway unavailable"));
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await expect(
        deliveryFailuresResubmitCommand(id, { queue: "session" }, runtime),
      ).rejects.toThrow("Gateway unavailable");
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT status FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?",
          )
          .get(id),
      ).toEqual({ status: "failed" });
      expect(runtime.log).not.toHaveBeenCalled();
    });
  });

  it("reports scheduler failure as a durably queued session delivery", async () => {
    gatewayMocks.call.mockResolvedValue({
      ok: true,
      queueName: "session",
      disposition: "queued_for_startup",
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await deliveryFailuresResubmitCommand("durable-session", { queue: "session" }, runtime);

    const output = String(runtime.log.mock.calls[0]?.[0]);
    expect(output).toContain("durably queued");
    expect(output).toContain("immediate scheduling failed or was unavailable");
    expect(output).not.toContain("resubmit failed");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("directs ambiguous IDs to an explicit physical queue", async () => {
    gatewayMocks.call.mockResolvedValue({
      ok: false,
      reason: "ambiguous_queue",
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await deliveryFailuresResubmitCommand("shared-id", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--queue session"));
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--queue outbound-prepared-v1"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
