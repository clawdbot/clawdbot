type ProgressVisibilityCallbackResult = boolean | void | Promise<boolean | void>;

/** Await progress without changing the legacy `void` acceptance contract. */
export async function settleProgressVisibilityCallbackResult(
  callbackResult: ProgressVisibilityCallbackResult,
): Promise<{ result: boolean | void; visible: boolean }> {
  const result = await callbackResult;
  return { result, visible: result !== false };
}
