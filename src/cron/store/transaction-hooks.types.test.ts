import { expectTypeOf, it } from "vitest";
import type { CronStoreTransactionHooks } from "./transaction-hooks.types.js";

type CronStoreHook = NonNullable<CronStoreTransactionHooks[keyof CronStoreTransactionHooks]>;

it("requires explicitly synchronous cron write and post-commit hooks", () => {
  const hooks: CronStoreTransactionHooks = {
    beforeWrite() {},
    afterWrite() {},
    afterCommit() {},
  };
  expectTypeOf(hooks.beforeWrite!).returns.toEqualTypeOf<undefined>();
  expectTypeOf<() => Promise<void>>().not.toExtend<CronStoreHook>();
  expectTypeOf<() => PromiseLike<undefined>>().not.toExtend<CronStoreHook>();
  // A void callback could have erased an async implementation's Promise return.
  expectTypeOf<() => void>().not.toExtend<CronStoreHook>();
});
