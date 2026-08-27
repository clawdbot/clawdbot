import { render } from "lit";
import { expect, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

export function createComposerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: crypto.randomUUID(),
    sessionKey: "main",
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft: "",
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    assistantName: "OpenClaw",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onQueueRemove: vi.fn(),
    ...overrides,
  };
}

export function renderComposerFixture(overrides: Partial<ComposerProps> = {}) {
  const container = document.createElement("div");
  const props = createComposerProps(overrides);
  render(renderChatComposer(props), container);
  return { container, props };
}

export function findComposerButton(container: Element, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) {
    throw new Error(`expected button ${label}`);
  }
  return result;
}

export function findPrimaryButton(container: Element): HTMLButtonElement {
  const actions = container.querySelector(".agent-chat__composer-actions");
  const result = actions?.querySelector<HTMLButtonElement>(":scope > openclaw-tooltip > button");
  if (!result) {
    throw new Error("expected one primary composer button");
  }
  expect(actions?.querySelectorAll(":scope > openclaw-tooltip > button")).toHaveLength(1);
  return result;
}

export async function resetComposerFixture(afterStateReset?: () => void): Promise<void> {
  resetChatComposerState();
  afterStateReset?.();
  localStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
}
