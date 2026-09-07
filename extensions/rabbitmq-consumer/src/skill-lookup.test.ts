import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import type { HistoryDbConfig } from "./types.js";

const { mockExecute, mockEnd } = vi.hoisted(() => ({
  mockExecute: vi.fn<(...args: unknown[]) => Promise<[unknown[], unknown]>>(),
  mockEnd: vi.fn(async () => {}),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({ execute: mockExecute, end: mockEnd })),
  },
}));

const { SkillLookup } = await import("./skill-lookup.js");

const DB_CONFIG: HistoryDbConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "tester",
  password: "secret",
  database: "superworker",
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as PluginLogger;

describe("SkillLookup", () => {
  let lookup: InstanceType<typeof SkillLookup>;

  beforeEach(() => {
    lookup = new SkillLookup(DB_CONFIG);
  });

  afterEach(async () => {
    await lookup.close();
    vi.clearAllMocks();
  });

  it("checks administrator ownership, publication and enablement for new built-in names", async () => {
    mockExecute.mockResolvedValueOnce([[{ id: 99 }], undefined]);
    await expect(lookup.isPublishedPublicSkill("new-skill")).resolves.toBe(true);
    expect(mockExecute).toHaveBeenCalledWith(
      "SELECT id FROM skills WHERE user_id = ? AND COALESCE(slug, name) = ? AND category = 'builtin' AND is_enable = 1 LIMIT 1",
      [126, "new-skill"],
    );
    mockExecute.mockResolvedValueOnce([[], undefined]);
    await expect(lookup.isPublishedPublicSkill("private-skill")).resolves.toBe(false);
  });

  it("lists enabled owned skills as metadata only", async () => {
    mockExecute.mockResolvedValueOnce([
      [
        { id: 9, name: "技能九", description: null },
        { id: 7, name: "技能七", description: "说明" },
      ],
      undefined,
    ]);

    await expect(lookup.listForUser("42", logger)).resolves.toEqual([
      { id: 9, name: "技能九", description: null },
      { id: 7, name: "技能七", description: "说明" },
    ]);
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("FROM skills"), ["42"]);
    expect(mockExecute.mock.calls[0]?.[0]).toContain("is_enable = 1");
    expect(mockExecute.mock.calls[0]?.[0]).not.toContain("content");
  });

  it("does not query for an empty user id", async () => {
    await expect(lookup.listForUser("   ", logger)).resolves.toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("logs and rethrows database failures for the HTTP layer", async () => {
    const error = new Error("connection refused");
    mockExecute.mockRejectedValueOnce(error);

    await expect(lookup.listForUser("42", logger)).rejects.toBe(error);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[SKILL_LOOKUP] List failed for user 42"),
    );
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });

  it("resolves enabled owned skills in the caller's requested order", async () => {
    mockExecute.mockResolvedValueOnce([
      [
        { id: 9, name: "技能九", content: "九的内容", description: null },
        { id: 7, name: "技能七", content: "七的内容", description: "说明" },
      ],
      undefined,
    ]);

    await expect(lookup.resolveMany([7, 9, 7, 0], "42", logger)).resolves.toEqual([
      { id: 7, name: "技能七", content: "七的内容", description: "说明" },
      { id: 9, name: "技能九", content: "九的内容", description: null },
    ]);
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("id IN (?, ?)"), [7, 9, "42"]);
  });

  it("omits skills that are disabled, missing, or owned by another user", async () => {
    mockExecute.mockResolvedValueOnce([
      [{ id: 7, name: "技能七", content: "内容", description: null }],
      undefined,
    ]);

    await expect(lookup.resolveMany([7, 9], "42", logger)).resolves.toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("1/2 skill id(s) not found / not visible for user 42"),
    );
  });

  it("degrades to no custom skills when resolution fails", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection refused"));

    await expect(lookup.resolveMany([7], "42", logger)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[SKILL_LOOKUP] Lookup failed for user 42"),
    );
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });

  it("does not query when no valid skill ids remain", async () => {
    await expect(lookup.resolveMany([0, -1, 1.5], "42", logger)).resolves.toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
