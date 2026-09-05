import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

type Lease = {
  ownerId: string;
  actorRole: "ci" | "maintainer";
  leaseToken: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
  quarantineOnExpiry?: boolean;
  requestId?: string;
};
type Credential = { _id: string; kind: string; status: string; payload: unknown; lease?: Lease };
type BrokerContext = {
  db: {
    get(id: string): Promise<Credential | null>;
    patch(id: string, patch: Partial<Credential>): Promise<void>;
    insert(table: string, value: unknown): Promise<string>;
  };
  scheduler: { runAfter(delay: number, mutation: unknown, args: unknown): Promise<void> };
};
type Mutation = {
  handler(
    ctx: BrokerContext,
    args: Record<string, unknown>,
  ): Promise<{ status: string; code?: string }>;
};

// Execute the checked-in mutation bodies unchanged. Generated Convex registration
// and transactional storage are fixture adapters; this does not claim a deployed
// Convex transaction, scheduler, or credential-service integration test.
function brokerFixture() {
  const exports: Record<string, Mutation> = {};
  const source = readFileSync(
    new URL("../qa/convex-credential-broker/convex/credentials.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const validator = () => undefined;
  vm.runInNewContext(compiled.outputText, {
    exports,
    crypto: { randomUUID },
    Date,
    require(name: string) {
      if (name === "convex/values") {
        return {
          v: {
            union: validator,
            literal: validator,
            string: validator,
            number: validator,
            id: validator,
            optional: validator,
            boolean: validator,
            any: validator,
          },
        };
      }
      if (name === "./_generated/server") {
        return {
          internalMutation: (value: Mutation) => value,
          internalQuery: (value: Mutation) => value,
        };
      }
      if (name === "./_generated/api") {
        return { internal: { credentials: { quarantineExpiredLease: "quarantineExpiredLease" } } };
      }
      throw new Error(`Unexpected broker dependency: ${name}`);
    },
  });
  const row: Credential = {
    _id: "fixture-credential",
    kind: "telegram-test-userbot",
    status: "active",
    payload: {},
  };
  const events: Array<{ table: string; value: unknown }> = [];
  const scheduled: Array<{ delay: number; args: unknown }> = [];
  const ctx: BrokerContext = {
    db: {
      async get(id) {
        return id === row["_id"] ? structuredClone(row) : null;
      },
      async patch(id, patch) {
        expect(id).toBe(row["_id"]);
        Object.assign(row, patch);
      },
      async insert(table, value) {
        events.push({ table, value });
        return "fixture-event";
      },
    },
    scheduler: {
      async runAfter(delay, _mutation, args) {
        scheduled.push({ delay, args });
      },
    },
  };
  const invoke = (name: string, args: Record<string, unknown>) => exports[name]!.handler(ctx, args);
  return { row, events, scheduled, invoke };
}

function storedLease(actorRole: Lease["actorRole"], proof = false): Lease {
  return {
    ownerId: "fixture-owner",
    actorRole,
    leaseToken: "fixture-lease",
    acquiredAtMs: Date.now() - 1000,
    heartbeatAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 60000,
    ...(proof ? { quarantineOnExpiry: true, requestId: "a".repeat(64) } : {}),
  };
}

for (const operation of ["quarantineLease", "heartbeatLease", "releaseLease"] as const) {
  it.each(["ci", "maintainer"] as const)(
    `${operation} enforces stored %s role before any mutation`,
    async (role) => {
      const fixture = brokerFixture();
      fixture.row.lease = storedLease(role);
      const before = structuredClone(fixture.row);
      const args = {
        kind: fixture.row.kind,
        credentialId: fixture.row["_id"],
        ownerId: "fixture-owner",
        leaseToken: "fixture-lease",
      };
      expect(
        await fixture.invoke(operation, {
          ...args,
          actorRole: role === "ci" ? "maintainer" : "ci",
        }),
      ).toMatchObject({ status: "error", code: "AUTH_ROLE_MISMATCH" });
      expect(fixture.row).toEqual(before);
      expect(fixture.events).toEqual([]);
      expect(await fixture.invoke(operation, { ...args, actorRole: role })).toEqual({
        status: "ok",
      });
      if (operation === "quarantineLease") {
        expect(fixture.row).toMatchObject({ status: "disabled", lease: undefined });
        expect(fixture.events).toMatchObject([
          { table: "lease_events", value: { actorRole: role, eventType: "quarantine" } },
        ]);
      } else if (operation === "releaseLease") {
        expect(fixture.row.lease).toBeUndefined();
      } else {
        expect(fixture.row.lease?.actorRole).toBe(role);
        expect(fixture.row.lease!.expiresAtMs).toBeGreaterThan(before.lease!.expiresAtMs);
      }
    },
  );
}

it("preserves existing legacy leases while expiry recovery only consumes its exact proof lease", async () => {
  const fixture = brokerFixture();
  fixture.row.lease = storedLease("maintainer");
  fixture.row.lease.expiresAtMs = Date.now() - 1;
  const args = { credentialId: fixture.row["_id"], leaseToken: "fixture-lease" };
  const legacy = structuredClone(fixture.row);
  expect(await fixture.invoke("quarantineExpiredLease", args)).toEqual({ status: "ok" });
  expect(fixture.row).toEqual(legacy);
  fixture.row.lease = storedLease("ci", true);
  expect(await fixture.invoke("quarantineExpiredLease", args)).toEqual({ status: "ok" });
  expect(fixture.scheduled).toHaveLength(1);
  expect(fixture.scheduled[0]!.delay).toBeGreaterThan(0);
  fixture.row.lease!.expiresAtMs = Date.now() - 1;
  expect(
    await fixture.invoke("quarantineExpiredLease", { ...args, leaseToken: "obsolete-lease" }),
  ).toEqual({ status: "ok" });
  expect(fixture.row.status).toBe("active");
  expect(await fixture.invoke("quarantineExpiredLease", args)).toEqual({ status: "ok" });
  expect(fixture.row).toMatchObject({ status: "disabled", lease: undefined });
  expect(fixture.events).toMatchObject([
    { table: "lease_events", value: { actorRole: "ci", eventType: "quarantine" } },
  ]);
  expect(await fixture.invoke("quarantineExpiredLease", args)).toEqual({ status: "ok" });
  expect(fixture.events).toHaveLength(1);
});
