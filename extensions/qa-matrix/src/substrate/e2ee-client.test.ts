import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing } from "./e2ee-client.js";

describe("matrix qa e2ee client storage", () => {
  it("filters receipt noise without suppressing room state or timeline events", () => {
    expect(__testing.MATRIX_QA_E2EE_SYNC_FILTER).toEqual({
      room: {
        ephemeral: { not_types: ["m.receipt"] },
      },
    });
  });

  it("shares persisted crypto and sync state by actor account", () => {
    const first = __testing.buildMatrixQaE2eeStoragePaths({
      actorId: "driver",
      outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
      scenarioId: "matrix-e2ee-basic-reply",
    });
    const second = __testing.buildMatrixQaE2eeStoragePaths({
      actorId: "driver",
      outputDir: "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
      scenarioId: "matrix-e2ee-qr-verification",
    });

    expect(first.accountDir).toBe(
      path.join(
        "/tmp/openclaw/.artifacts/qa-e2e/matrix-run",
        "matrix-e2ee",
        "accounts",
        "driver",
        "account",
      ),
    );
    expect(first.cryptoDatabasePrefix).toBe(second.cryptoDatabasePrefix);
    expect(first.recoveryKeyPath).toBe(path.join(first.accountDir, "recovery-key.json"));
    expect(first.storagePath).toBe(path.join(first.accountDir, "sync-store.json"));
    expect(second.storagePath).toBe(first.storagePath);
  });

  it("records late-decrypted payload updates for an existing event id", () => {
    const previous = {
      eventId: "$reply",
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      sender: "@bot:matrix-qa.test",
      type: "m.room.message",
    };

    expect(
      __testing.shouldRecordMatrixQaObservedEventUpdate({
        previous,
        next: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
      }),
    ).toBe(true);
    expect(
      __testing.shouldRecordMatrixQaObservedEventUpdate({
        previous: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
        next: {
          ...previous,
          body: "MATRIX_QA_E2EE_CLI_GATEWAY_OK",
          msgtype: "m.text",
        },
      }),
    ).toBe(false);
  });
});
