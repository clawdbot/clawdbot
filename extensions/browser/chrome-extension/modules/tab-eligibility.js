export function isValidTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function effectiveTabUrl(tab) {
  return tab?.pendingUrl ?? tab?.url;
}

function ordinaryDocumentUrl(rawUrl, fileAccessAllowed) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" ||
    url.protocol === "https:" ||
    url.protocol === "data:" ||
    (url.protocol === "blob:" && /^https?:\/\//u.test(url.origin)) ||
    (url.protocol === "file:" && fileAccessAllowed)
  );
}

/** Pure owner of the ordinary-document eligibility boundary. */
export function tabEligibility(tab, { fileAccessAllowed = true, controlledBlank = false } = {}) {
  const urls = [tab?.url, tab?.pendingUrl].filter(
    (url) => typeof url === "string" && url.length > 0,
  );
  if (!tab || !isValidTabId(tab.id) || urls.length === 0) {
    return { eligible: false, reason: "missing" };
  }
  if (tab.incognito === true) {
    return { eligible: false, reason: "incognito" };
  }
  return urls.every(
    (url) =>
      (controlledBlank && url === "about:blank") || ordinaryDocumentUrl(url, fileAccessAllowed),
  )
    ? { eligible: true, reason: null }
    : { eligible: false, reason: "restricted" };
}
