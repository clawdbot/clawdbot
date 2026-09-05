import { expectTypeOf, it } from "vitest";
import type { transitionOwnedDeliveryQueueEntry } from "./delivery-queue-sqlite-claim.js";

type OwnedDeliveryTransition = Parameters<typeof transitionOwnedDeliveryQueueEntry>[1];

it("requires an explicitly synchronous owned delivery transition", () => {
  const transition: OwnedDeliveryTransition = () => {};
  expectTypeOf(transition).returns.toEqualTypeOf<undefined>();
  expectTypeOf<() => Promise<void>>().not.toExtend<OwnedDeliveryTransition>();
  expectTypeOf<() => PromiseLike<undefined>>().not.toExtend<OwnedDeliveryTransition>();
  // A void callback could have erased an async implementation's Promise return.
  expectTypeOf<() => void>().not.toExtend<OwnedDeliveryTransition>();
});
