import { describe, expect, it } from "vitest";
import { newSessionLocationFromSearch, newSessionSearch } from "./location.ts";

describe("new-session location", () => {
  it("round-trips a catalog creation target", () => {
    const search = newSessionSearch("main/agent", {
      catalogId: "claude",
    });

    expect(search).toBe("?agent=main%2Fagent&catalog=claude");
    expect(
      newSessionLocationFromSearch(`${search}&model=openai%2Fgpt-5&label=Claude+Code`),
    ).toEqual({
      agentId: "main/agent",
      catalogId: "claude",
    });
  });

  it("keeps the plain entry point empty", () => {
    expect(newSessionSearch("")).toBe("");
    expect(newSessionLocationFromSearch("")).toEqual({
      agentId: "",
      catalogId: "",
    });
  });
});
