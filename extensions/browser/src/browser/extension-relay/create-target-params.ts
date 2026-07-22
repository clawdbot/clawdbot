export function resolveCreateTargetParams(params: Record<string, unknown> | undefined) {
  const background = params?.background;
  const focus = params?.focus;
  if (background === true && focus === true) {
    throw new Error("Target.createTarget does not support background=true with focus=true");
  }
  // OpenClaw changes only the fully omitted automation case to background.
  // Explicit focus keeps the CDP foreground semantics for both boolean values.
  const resolvedBackground =
    focus === undefined ? background !== false : background === true && focus === false;
  return {
    background: resolvedBackground,
    focus: focus === true || (focus === undefined && !resolvedBackground),
  };
}
