/**
 * Live-provider model error classifiers.
 *
 * Probe and fallback code uses these string checks to distinguish missing or
 * deprecated model ids from generic provider/runtime failures.
 */
/** Returns whether a provider error message indicates a missing or retired model id. */
export function isModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  if (!msg) {
    return false;
  }
  if (/no endpoints found for/i.test(msg)) {
    return true;
  }
  if (/\brouter not found\b/i.test(msg)) {
    return true;
  }
  if (/unknown model/i.test(msg)) {
    return true;
  }
  if (/model(?:[_\-\s])?not(?:[_\-\s])?found/i.test(msg)) {
    return true;
  }
  if (/\b404\b/.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) {
    return true;
  }
  if (/not_found_error/i.test(msg)) {
    return true;
  }
  if (/\bnot supported model\b/i.test(msg)) {
    return true;
  }
  // OpenAI-backed runtimes reject account/plan-restricted models with
  // "The '<model>' model is not supported when using <runtime> with <account>".
  // The model id must change (or the account), so treat it as model-unavailable;
  // the account suffix keeps capability errors out of this class.
  if (
    /\bmodel\b[^.]{0,120}?\bis not supported when using\b[^.]{0,80}?\bwith a ChatGPT account\b/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/model:\s*[a-z0-9._/-]+/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) {
    return true;
  }
  if (/models\/[^\s]+ is not found/i.test(msg)) {
    return true;
  }
  if (/model/i.test(msg) && /does not exist/i.test(msg)) {
    return true;
  }
  if (/selected model/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) {
    return true;
  }
  if (/model/i.test(msg) && /deprecated/i.test(msg) && /(upgrade|transition) to/i.test(msg)) {
    return true;
  }
  if (/stealth model/i.test(msg) && /find it here/i.test(msg)) {
    return true;
  }
  if (/is not a valid model id/i.test(msg)) {
    return true;
  }
  if (/invalid model/i.test(msg) && !/invalid model reference/i.test(msg)) {
    return true;
  }
  return false;
}
