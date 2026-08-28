const RENDERABLE_ASSISTANT_MEDIA_PREFIX_RE =
  /^(?:https?:\/\/|data:(?:image|audio|video)\/|file:\/\/|~|\/|[a-z]:[\\/])/iu;

export function isRenderableAssistantMediaReference(url: string): boolean {
  return RENDERABLE_ASSISTANT_MEDIA_PREFIX_RE.test(url.trim());
}

export function isRelativeAssistantMediaReference(url: string): boolean {
  const trimmed = url.trim();
  return Boolean(trimmed) && !isRenderableAssistantMediaReference(trimmed);
}
