import { describe, expect, it } from "vitest";
import { createMSTeamsHttpError, readMSTeamsHttpErrorDetail } from "./http-error.js";

function bodyOnlyErrorResponse(body: string, status = 429): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: new Response(body).body,
  } as unknown as Response;
}

describe("msteams http errors", () => {
  it("creates bounded provider errors without relying on response.text()", async () => {
    const error = await createMSTeamsHttpError(
      bodyOnlyErrorResponse(`${"x".repeat(24 * 1024)}tail-marker`),
      "Teams request failed",
    );

    expect(error.message).toContain("Teams request failed (429):");
    expect(error.message).not.toContain("tail-marker");
    expect(error.message.length).toBeLessThan(700);
    expect((error as { statusCode?: number }).statusCode).toBe(429);
  });

  it("returns a bounded response detail for non-throwing callers", async () => {
    const detail = await readMSTeamsHttpErrorDetail(
      bodyOnlyErrorResponse(`${"denied ".repeat(4096)}tail-marker`, 403),
      "HTTP 403",
    );

    expect(detail).toContain("denied");
    expect(detail).not.toContain("tail-marker");
    expect(detail.length).toBeLessThan(700);
  });
});
