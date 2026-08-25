import type { Page } from "playwright";

export function sessionOwnershipList(owners: [string, string], withAvatars = false) {
  const ownerFacet = [
    {
      type: "human" as const,
      id: owners[0],
      label: "Ada",
      ...(withAvatars ? { avatarUrl: `/api/users/${owners[0]}/avatar?v=1` } : {}),
    },
    ...(owners[1] === owners[0]
      ? []
      : [
          {
            type: "human" as const,
            id: owners[1],
            label: "Bob",
            ...(withAvatars ? { avatarUrl: `/api/users/${owners[1]}/avatar?v=1` } : {}),
          },
        ]),
  ];
  return {
    count: 2,
    owners: ownerFacet,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada",
        kind: "direct",
        label: "Ada research",
        category: "Research",
        createdActor: { type: "human", id: owners[0], label: "Ada" },
        owner: { actor: { type: "human", id: owners[0], label: "Ada" } },
        updatedAt: 2,
      },
      {
        key: "agent:main:bob",
        kind: "direct",
        label: "Bob operations",
        category: "Operations",
        createdActor: {
          type: "human",
          id: owners[1],
          label: owners[1] === owners[0] ? "Ada" : "Bob",
        },
        owner: {
          actor: {
            type: "human",
            id: owners[1],
            label: owners[1] === owners[0] ? "Ada" : "Bob",
          },
        },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

export async function openSessionOwnershipMenu(page: Page) {
  const trigger = page.getByRole("button", { name: "Filter & sort" });
  await trigger.waitFor();
  await trigger.click();
  const menu = page.locator(".sidebar-session-sort-menu");
  await menu.waitFor();
  return menu;
}
