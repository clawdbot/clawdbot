/** Terminal caller/input failure for Gateway-owned conversation operations. */
export class ConversationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationInputError";
  }
}

/** Durable operation id already belongs to a different request identity. */
export class ConversationOperationConflictError extends ConversationInputError {
  constructor(message: string) {
    super(message);
    this.name = "ConversationOperationConflictError";
  }
}
