// Shared OpenAI-compatible `tool_choice` contract for the Chat Completions
// (`/v1/chat/completions`) and Responses (`/v1/responses`) HTTP endpoints. Both
// accept `required` and pinned-function choices for caller-supplied client tools.
// The agent runtime cannot force every upstream provider, so the HTTP boundary
// narrows exposed tools, nudges the model, then rejects turns without a matching
// structured client-tool call. Keeping this here keeps the endpoints aligned.

export type ToolChoiceConstraint = { type: "required" } | { type: "function"; name: string };

export function toolChoiceConstraintPrompt(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `You must call the ${constraint.name} tool before responding.`
    : "You must call one of the available tools before responding.";
}

// True when no constraint is active, or the agent produced a structured tool
// call that honors it: any call for `required`, a name match for a pinned
// function. Callers reject the turn when this returns false.
export function isToolChoiceConstraintSatisfied(params: {
  constraint: ToolChoiceConstraint | undefined;
  pendingToolCalls: ReadonlyArray<{ name: string }> | undefined;
}): boolean {
  const { constraint, pendingToolCalls } = params;
  if (!constraint) {
    return true;
  }
  if (!pendingToolCalls || pendingToolCalls.length === 0) {
    return false;
  }
  if (constraint.type === "required") {
    return true;
  }
  return pendingToolCalls.some((call) => call.name === constraint.name);
}

export function resolveUnsatisfiedToolChoiceMessage(constraint: ToolChoiceConstraint): string {
  return constraint.type === "function"
    ? `tool_choice required a ${constraint.name} tool call, but the agent did not produce one`
    : "tool_choice=required was not satisfied by the agent response";
}
