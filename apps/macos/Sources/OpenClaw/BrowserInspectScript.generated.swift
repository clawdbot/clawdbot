// Generated file. Do not edit directly.
// Source: ui/src/components/browser/browser-inspect-script.ts
// Regenerate: pnpm gen:browser-inspect-script:swift

enum BrowserInspectScript {
    static let source = #"""
    function openclawInspectBrowserElement(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      const nameSource = label || text;
      const nameLimit = 120;
      // This serialized page function cannot call imported helpers; back up only when the cap splits a surrogate pair.
      const nameEnd = (nameSource.codePointAt(nameLimit - 1) || 0) > 0xffff ? nameLimit - 1 : nameLimit;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        classes: Array.from(el.classList).slice(0, 6),
        role: el.getAttribute("role") || "",
        name: nameSource.slice(0, nameEnd),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        focusable: typeof el.tabIndex === "number" && el.tabIndex >= 0,
      };
    }
    """#
}
