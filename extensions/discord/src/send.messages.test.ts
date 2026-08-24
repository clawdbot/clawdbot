// Discord tests cover send.messages plugin behavior.
import { describe, expect, it, vi } from "vitest";

const restMock = {
  get: vi.fn(),
};

vi.mock("./send.shared.js", () => ({
  resolveDiscordRest: () => restMock,
}));

const { readMessagesDiscord, searchMessagesDiscord } = await import("./send.messages.js");

const restErrorCases: Array<{
  name: string;
  invoke: () => Promise<unknown>;
}> = [
  {
    name: "readMessagesDiscord",
    invoke: () => readMessagesDiscord("C1", {}, { cfg: {} as never }),
  },
  {
    name: "searchMessagesDiscord",
    invoke: () => searchMessagesDiscord({ guildId: "G1", content: "test" }, { cfg: {} as never }),
  },
];

describe("Discord message REST error handling", () => {
  it.each(restErrorCases)("$name propagates REST errors", async ({ invoke }) => {
    restMock.get.mockRejectedValueOnce(new Error("Discord API error"));

    await expect(invoke()).rejects.toThrow("Discord API error");
  });
});

describe("readMessagesDiscord", () => {
  it("returns messages from the REST client", async () => {
    const messages = [{ id: "1", content: "hello" }];
    restMock.get.mockResolvedValueOnce(messages);

    const result = await readMessagesDiscord("C1", { limit: 5 }, { cfg: {} as never });

    expect(result).toEqual(messages);
    expect(restMock.get).toHaveBeenCalledWith("/channels/C1/messages", { limit: 5 });
  });

  it("throws a clear error when Discord returns a non-array message read response", async () => {
    restMock.get.mockResolvedValueOnce("\u001f\ufffd\u0008raw gzip bytes");

    await expect(readMessagesDiscord("C1", {}, { cfg: {} as never })).rejects.toThrow(
      "Unexpected Discord response for message read: expected array.",
    );
  });
});

describe("searchMessagesDiscord", () => {
  it("returns search results from the REST client", async () => {
    const results = { messages: [[{ id: "1" }]], total_results: 1 };
    restMock.get.mockResolvedValueOnce(results);

    const result = await searchMessagesDiscord(
      { guildId: "G1", content: "test", limit: 1 },
      { cfg: {} as never },
    );

    expect(result).toEqual(results);
  });

  it("preserves valid empty Discord search results", async () => {
    const results = { messages: [], total_results: 0 };
    restMock.get.mockResolvedValueOnce(results);

    await expect(
      searchMessagesDiscord({ guildId: "G1", content: "test" }, { cfg: {} as never }),
    ).resolves.toEqual(results);
  });

  it("surfaces a pending Discord search index and its retry delay", async () => {
    restMock.get.mockResolvedValueOnce({
      message: "Index not yet available. Try again later",
      code: 110000,
      documents_indexed: 0,
      retry_after: 2,
    });

    await expect(
      searchMessagesDiscord({ guildId: "G1", content: "test" }, { cfg: {} as never }),
    ).rejects.toThrow(
      "Discord message search unavailable: Index not yet available. Try again later (retry after 2s)",
    );
  });

  it("rejects object search responses without a messages array", async () => {
    restMock.get.mockResolvedValueOnce({ total_results: 1 });

    await expect(
      searchMessagesDiscord({ guildId: "G1", content: "test" }, { cfg: {} as never }),
    ).rejects.toThrow("Unexpected Discord response for message search: expected messages array.");
  });

  it("throws a clear error when Discord returns a non-object search response", async () => {
    restMock.get.mockResolvedValueOnce("\u001f\ufffd\u0008raw gzip bytes");

    await expect(
      searchMessagesDiscord({ guildId: "G1", content: "test" }, { cfg: {} as never }),
    ).rejects.toThrow("Unexpected Discord response for message search: expected object.");
  });
});
