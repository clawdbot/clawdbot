import { describe, expect, it } from "vitest";
import { createCodexSupervisionTools } from "./supervision-tools.js";

type Options = Parameters<typeof createCodexSupervisionTools>[0];
type EndpointRequest = NonNullable<Options["request"]>;

function toolByName(tools: ReturnType<typeof createCodexSupervisionTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

describe("Codex endpoint probe diagnostics", () => {
  it("bounds and redacts bearer and named credentials", async () => {
    const bearerToken = "super-secret-bearer-token-0123456789";
    const accessToken = "super-secret-access-token-0123456789";
    const trailingDiagnostic = "x".repeat(600);
    const request: EndpointRequest = async () => {
      throw new Error(
        `Codex app-server rejected Bearer ${bearerToken}; access_token=${accessToken} ${trailingDiagnostic}`,
      );
    };
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          endpoints: [{ id: "broken", transport: "stdio-proxy" }],
        },
      }),
      senderIsOwner: true,
      request,
    });

    const result = await toolByName(tools, "codex_endpoint_probe").execute("probe", {});
    const output = JSON.stringify(result);
    const parsed = JSON.parse(output) as { details: { health: Array<{ detail?: string }> } };
    const detail = parsed.details.health[0]?.detail;

    if (typeof detail !== "string") {
      throw new Error("endpoint probe did not return a failure detail");
    }

    expect(detail).toContain("Bearer <redacted>");
    expect(detail).toContain("access_token=<redacted>");
    expect(detail).toMatch(/\.\.\.$/);
    expect(detail.length).toBe(503);
    expect(output).not.toContain(bearerToken);
    expect(output).not.toContain(accessToken);
    expect(output).not.toContain(trailingDiagnostic);
  });

  it("redacts colon-delimited credentials", async () => {
    const apiKey = "super-secret-api-key-0123456789";
    const request: EndpointRequest = async () => {
      throw new Error(`Codex app-server rejected X-Api-Key: ${apiKey}`);
    };
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          endpoints: [{ id: "broken", transport: "stdio-proxy" }],
        },
      }),
      senderIsOwner: true,
      request,
    });

    const output = JSON.stringify(
      await toolByName(tools, "codex_endpoint_probe").execute("probe", {}),
    );

    expect(output).toContain("X-Api-Key: <redacted>");
    expect(output).not.toContain(apiKey);
  });
});
