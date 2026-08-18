export class MessageActionDeniedError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly policyRef: string,
  ) {
    super(message);
    this.name = "MessageActionDeniedError";
  }
}
