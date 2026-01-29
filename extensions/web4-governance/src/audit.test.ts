import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditChain } from "./audit.js";
import { createR6Request } from "./r6.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".test-audit-tmp");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function makeR6(actionIndex: number, toolName = "Read") {
  return createR6Request("test-session", "agent-1", toolName, { file_path: "/foo" }, actionIndex, undefined, "standard");
}

describe("AuditChain", () => {
  afterEach(cleanup);

  it("should create audit directory on construction", () => {
    cleanup();
    new AuditChain(TEST_DIR, "s1");
    expect(existsSync(join(TEST_DIR, "audit"))).toBe(true);
  });

  it("should record an audit entry and write to JSONL", () => {
    cleanup();
    const chain = new AuditChain(TEST_DIR, "s1");
    const r6 = makeR6(0);
    const record = chain.record(r6, { status: "success", outputHash: "abc123" });

    expect(record.recordId).toMatch(/^audit:/);
    expect(record.r6RequestId).toBe(r6.id);
    expect(record.tool).toBe("Read");
    expect(record.result.status).toBe("success");
    expect(record.provenance.prevRecordHash).toBe("genesis");
    expect(chain.count).toBe(1);

    const filePath = join(TEST_DIR, "audit", "s1.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.recordId).toBe(record.recordId);
  });

  it("should chain records with hash links", () => {
    cleanup();
    const chain = new AuditChain(TEST_DIR, "s1");
    chain.record(makeR6(0), { status: "success" });
    const second = chain.record(makeR6(1), { status: "success" });

    expect(second.provenance.prevRecordHash).not.toBe("genesis");
    expect(second.provenance.prevRecordHash).toMatch(/^[a-f0-9]{16}$/);
    expect(chain.count).toBe(2);
  });

  it("should verify a valid chain", () => {
    cleanup();
    const chain = new AuditChain(TEST_DIR, "s1");
    chain.record(makeR6(0), { status: "success" });
    chain.record(makeR6(1), { status: "success" });
    chain.record(makeR6(2), { status: "error", errorMessage: "boom" });

    const result = chain.verify();
    expect(result.valid).toBe(true);
    expect(result.recordCount).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("should verify an empty/nonexistent chain as valid", () => {
    cleanup();
    const chain = new AuditChain(TEST_DIR, "nonexistent");
    const result = chain.verify();
    expect(result.valid).toBe(true);
    expect(result.recordCount).toBe(0);
  });

  it("should resume chain state from existing file", () => {
    cleanup();
    const chain1 = new AuditChain(TEST_DIR, "s1");
    chain1.record(makeR6(0), { status: "success" });
    chain1.record(makeR6(1), { status: "success" });

    // Recreate from same file
    const chain2 = new AuditChain(TEST_DIR, "s1");
    expect(chain2.count).toBe(2);
    chain2.record(makeR6(2), { status: "success" });

    const result = chain2.verify();
    expect(result.valid).toBe(true);
    expect(result.recordCount).toBe(3);
  });

  it("should retrieve last N records", () => {
    cleanup();
    const chain = new AuditChain(TEST_DIR, "s1");
    for (let i = 0; i < 5; i++) {
      chain.record(makeR6(i, i % 2 === 0 ? "Read" : "Write"), { status: "success" });
    }

    const last3 = chain.getLast(3);
    expect(last3).toHaveLength(3);
    expect(last3[0]!.provenance.actionIndex).toBe(2);
    expect(last3[2]!.provenance.actionIndex).toBe(4);
  });

  it("should return empty array for getLast on nonexistent file", () => {
    cleanup();
    const chain = new AuditChain(TEST_DIR, "nope");
    expect(chain.getLast(10)).toEqual([]);
  });

  describe("filter", () => {
    function populateChain() {
      cleanup();
      const chain = new AuditChain(TEST_DIR, "filter-test");
      // Record a mix of tools and statuses
      chain.record(makeR6(0, "Read"), { status: "success", durationMs: 10 });
      chain.record(makeR6(1, "Bash"), { status: "success", durationMs: 50 });
      chain.record(makeR6(2, "Bash"), { status: "error", errorMessage: "exit 1", durationMs: 20 });
      chain.record(makeR6(3, "WebFetch"), { status: "blocked" });
      chain.record(makeR6(4, "Read"), { status: "success", durationMs: 5 });
      return chain;
    }

    it("should filter by tool", () => {
      const chain = populateChain();
      const results = chain.filter({ tool: "Bash" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.tool === "Bash")).toBe(true);
    });

    it("should filter by status", () => {
      const chain = populateChain();
      const results = chain.filter({ status: "error" });
      expect(results).toHaveLength(1);
      expect(results[0]!.result.status).toBe("error");
    });

    it("should filter by status blocked", () => {
      const chain = populateChain();
      const results = chain.filter({ status: "blocked" });
      expect(results).toHaveLength(1);
      expect(results[0]!.tool).toBe("WebFetch");
    });

    it("should filter by category", () => {
      const chain = populateChain();
      const results = chain.filter({ category: "file_read" });
      expect(results).toHaveLength(2);
    });

    it("should filter by target pattern", () => {
      const chain = populateChain();
      // All records in this test have target "/foo"
      const results = chain.filter({ targetPattern: "/foo" });
      expect(results).toHaveLength(5);
      const noResults = chain.filter({ targetPattern: "/bar" });
      expect(noResults).toHaveLength(0);
    });

    it("should combine multiple filters", () => {
      const chain = populateChain();
      const results = chain.filter({ tool: "Bash", status: "success" });
      expect(results).toHaveLength(1);
    });

    it("should respect limit", () => {
      const chain = populateChain();
      const results = chain.filter({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("should default limit to 50", () => {
      const chain = populateChain();
      const results = chain.filter({});
      expect(results).toHaveLength(5);
    });

    it("should return empty for no matches", () => {
      const chain = populateChain();
      const results = chain.filter({ tool: "NonexistentTool" });
      expect(results).toHaveLength(0);
    });

    it("should return empty for nonexistent chain", () => {
      cleanup();
      const chain = new AuditChain(TEST_DIR, "nope");
      expect(chain.filter({ tool: "Bash" })).toEqual([]);
    });
  });

  describe("getAll", () => {
    it("should return all records", () => {
      cleanup();
      const chain = new AuditChain(TEST_DIR, "all-test");
      for (let i = 0; i < 5; i++) {
        chain.record(makeR6(i), { status: "success" });
      }
      expect(chain.getAll()).toHaveLength(5);
    });

    it("should return empty for nonexistent file", () => {
      cleanup();
      const chain = new AuditChain(TEST_DIR, "nope");
      expect(chain.getAll()).toEqual([]);
    });
  });
});
