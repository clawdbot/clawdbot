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
});
