import { describe, expect } from "vitest";
import { skillLibraryMockInitScript } from "../../scripts/control-ui-mock-skill-library.js";
import { createControlUiMockGatewayInitScript } from "../../ui/src/test-helpers/control-ui-e2e.js";
import { mockGatewayTest as it } from "../../ui/src/test-helpers/mock-gateway-page.test-support.js";
import { buildSkillLibraryMock } from "../../ui/src/test-helpers/skill-library-fixtures.js";

type ResponseFrame = {
  type: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

async function installPreview(
  window: Window & typeof globalThis,
  execute: (script: string) => void,
) {
  window.history.replaceState(null, "", "/?skillLibrary=collaborator");
  window.structuredClone = structuredClone;
  execute(createControlUiMockGatewayInitScript({ methodResponses: { health: { ok: true } } }));
  execute(skillLibraryMockInitScript());
  const sockets = [
    new window.WebSocket("ws://mock-gateway/first"),
    new window.WebSocket("ws://mock-gateway/second"),
  ];
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) =>
          socket.addEventListener("open", () => resolve(), { once: true }),
        ),
    ),
  );
  let nextId = 0;
  const request = (
    method: string,
    params: Record<string, unknown> = { sessionKey: "agent:main:preview" },
    socket = sockets[0]!,
  ) => {
    const id = String(++nextId);
    return new Promise<ResponseFrame>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as ResponseFrame;
        if (frame.type === "res" && frame.id === id) {
          socket.removeEventListener("message", onMessage);
          resolve(frame);
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  };
  return { request, sockets };
}

describe("skill library preview catalogs", () => {
  it.for(["commands.list", "chat.metadata"])(
    "serves the selected pin through %s",
    async (method, { gatewayPage }) => {
      const { request } = await installPreview(gatewayPage.window, gatewayPage.execute);
      const [selected] = buildSkillLibraryMock();
      const result = await request(method);
      expect(result).toMatchObject({
        ok: true,
        payload: { commands: [{ name: selected.entry.name, source: "skill", scope: "both" }] },
      });
      if (method === "chat.metadata") {
        expect(result.payload).toMatchObject({ models: [] });
      }
    },
  );

  it("keeps concurrent library results on their requesting session and socket", async ({
    gatewayPage,
  }) => {
    const { request, sockets } = await installPreview(gatewayPage.window, gatewayPage.execute);
    const [selected] = buildSkillLibraryMock();
    expect(
      await request("skills.library.activate", {
        sessionKey: "agent:main:detached",
        skillId: selected.entry.skillId,
        action: "detach",
      }),
    ).toMatchObject({ ok: true, payload: { selections: [] } });

    const [pinned, detached, health, denied] = await Promise.all([
      request("skills.library.list", { sessionKey: "agent:main:pinned" }, sockets[0]),
      request("skills.library.list", { sessionKey: "agent:main:detached" }, sockets[1]),
      request("health", {}, sockets[0]),
      request("skills.library.read", { skillId: selected.entry.skillId }, sockets[1]),
    ]);
    expect(pinned).toMatchObject({
      ok: true,
      payload: {
        session: {
          sessionKey: "agent:main:pinned",
          selections: [{ skillId: selected.entry.skillId }],
        },
      },
    });
    expect(detached).toMatchObject({
      ok: true,
      payload: { session: { sessionKey: "agent:main:detached", selections: [] } },
    });
    expect(health).toMatchObject({ ok: true, payload: { ok: true } });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { code: "SKILL_LIBRARY_FORBIDDEN" } },
    });
  });
});
