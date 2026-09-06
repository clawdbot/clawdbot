export type ChatInputRegion = "page" | "dock";

class ChatInputOwner {
  private region: ChatInputRegion = "page";
  private readonly listeners = new Set<() => void>();

  get current(): ChatInputRegion {
    return this.region;
  }

  claim(region: ChatInputRegion): void {
    if (this.region === region) {
      return;
    }
    this.region = region;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Focus belongs to one application, not a document-global singleton or a route.
const chatInputOwners = new WeakMap<object, ChatInputOwner>();

export function chatInputOwnerForContext(context: object): ChatInputOwner {
  let owner = chatInputOwners.get(context);
  if (!owner) {
    owner = new ChatInputOwner();
    chatInputOwners.set(context, owner);
  }
  return owner;
}
