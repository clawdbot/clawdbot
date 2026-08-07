import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

describe("renderAgents identity avatar controls", () => {
  it("prefills the identity editor from the fetched agent identity", () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentIdentityById: {
            beta: { agentId: "beta", name: "Fetched Beta", avatar: "" },
          },
        }),
      ),
      container,
    );

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")?.value,
    ).toBe("Fetched Beta");
  });

  it("offers Remove for a stored non-previewable avatar", () => {
    const onIdentityAvatarClear = vi.fn();
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "alpha", name: "Alpha" } as never,
              {
                id: "beta",
                name: "Beta",
                identity: { avatar: "https://example.com/avatar.png" },
              } as never,
            ],
          },
          agentIdentityById: {
            beta: {
              agentId: "beta",
              name: "Beta",
              avatar: "https://example.com/avatar.png",
            },
          },
          onIdentityAvatarClear,
        }),
      ),
      container,
    );

    const remove = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-identity-avatar-remove"]',
    );
    expect(remove).not.toBeNull();
    remove?.click();
    expect(onIdentityAvatarClear).toHaveBeenCalledOnce();
  });
});
