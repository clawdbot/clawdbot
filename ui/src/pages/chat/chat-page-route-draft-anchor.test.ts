/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-route-draft-anchor.test/"} */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSION_HISTORY_MESSAGE_ID_PARAM,
  SESSION_HISTORY_SESSION_ID_PARAM,
} from "../../lib/sessions/history-anchor.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatPage } from "./chat-page.ts";

function setNavigationContext(page: ChatPage) {
  const replace = vi.fn();
  const context = {
    basePath: "",
    sessions: {
      state: { result: null },
      subscribe: () => () => undefined,
      patch: vi.fn(async () => null),
    },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: { snapshot: { hello: null } },
    navigate: vi.fn(),
    replace,
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  return replace;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("preserves the history anchor while consuming draft and focus state", async () => {
  const page = new ChatPage();
  const replace = setNavigationContext(page);
  page.data = {
    sessionKey: "main",
    draft: "follow up",
    focusComposer: true,
    historyAnchor: {
      sessionId: "historical-session",
      messageId: "historical-message",
    },
  };

  document.body.append(page);
  await page.updateComplete;
  await Promise.resolve();
  await page.updateComplete;

  expect(replace).toHaveBeenCalledOnce();
  const options = replace.mock.calls[0]?.[1] as { search?: string } | undefined;
  const search = new URLSearchParams(options?.search);
  expect(search.get(SESSION_HISTORY_SESSION_ID_PARAM)).toBe("historical-session");
  expect(search.get(SESSION_HISTORY_MESSAGE_ID_PARAM)).toBe("historical-message");
  expect(search.has("draft")).toBe(false);
});
