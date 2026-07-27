export function selectChatModelProvider(event: MouseEvent, provider: string): void {
  event.preventDefault();
  event.stopPropagation();
  const menu = (event.currentTarget as HTMLElement).closest(
    ".chat-controls__inline-select-menu--combined",
  );
  if (!(menu instanceof HTMLElement)) {
    return;
  }
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      button.dataset.chatModelProvider === provider ? "true" : "false",
    );
  });
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]").forEach((group) => {
    group.hidden = group.dataset.chatModelProviderGroup !== provider;
  });
}
