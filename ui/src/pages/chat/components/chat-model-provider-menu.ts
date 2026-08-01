export function selectChatModelProvider(event: Event, provider: string): void {
  event.preventDefault();
  event.stopPropagation();
  const menu = (event.currentTarget as HTMLElement).closest(
    ".chat-controls__inline-select-menu--combined",
  );
  if (!(menu instanceof HTMLElement)) {
    return;
  }
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider]").forEach((button) => {
    const active = button.dataset.chatModelProvider === provider;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]").forEach((group) => {
    group.hidden = group.dataset.chatModelProviderGroup !== provider;
  });
}

export function moveChatModelProviderFocus(event: KeyboardEvent): void {
  const direction =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  const current = event.currentTarget as HTMLElement;
  const list = current.closest(".chat-controls__provider-list");
  const buttons = list
    ? [...list.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]")]
    : [];
  const currentIndex = buttons.indexOf(current as HTMLButtonElement);
  if (currentIndex < 0 || (direction === 0 && event.key !== "Home" && event.key !== "End")) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (currentIndex + direction + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}
