/** Named ingress error factory shared by channel payload and admission failures. */
type ChannelIngressErrorClass<TError extends Error, TArgs extends unknown[]> = {
  new (...args: TArgs): TError;
  readonly name: string;
  readonly prototype: TError;
};

export function createChannelIngressError(
  name: string,
): ChannelIngressErrorClass<Error, [message: string, options?: ErrorOptions]>;
export function createChannelIngressError<TReason extends string>(
  name: string,
  options: { withReason: true },
): ChannelIngressErrorClass<
  Error & { readonly reason: TReason },
  [reason: TReason, message: string, errorOptions?: ErrorOptions]
>;
export function createChannelIngressError(
  name: string,
  options?: { withReason?: boolean },
): unknown {
  const IngressError = class extends Error {
    declare readonly reason?: string;

    constructor(first: string, second?: string | ErrorOptions, third?: ErrorOptions) {
      const reasoned = options?.withReason === true;
      const message = reasoned && typeof second === "string" ? second : first;
      const errorOptions = reasoned ? third : typeof second === "string" ? undefined : second;
      super(message, errorOptions);
      this.name = name;
      if (reasoned) {
        this.reason = first;
      }
    }
  };
  Object.defineProperty(IngressError, "name", { configurable: true, value: name });
  return IngressError;
}
