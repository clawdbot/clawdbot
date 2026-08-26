import AppKit

@MainActor
enum StatusMenuMetrics {
    static let width: CGFloat = 330
    private static var chromeWidths: [String: CGFloat] = [:]

    static func fittedTitle(
        _ title: String,
        hasImage: Bool = false,
        hasSubmenu: Bool = false,
        keyEquivalent: String = "") -> String
    {
        let budget = self.titleWidthBudget(hasImage: hasImage, hasSubmenu: hasSubmenu, keyEquivalent: keyEquivalent)
        guard self.measuredWidth(title) > budget else { return title }
        let characters = Array(title)
        var bounds = (lower: 0, upper: characters.count)
        var fitted = "…"
        while bounds.lower <= bounds.upper {
            let count = (bounds.lower + bounds.upper) / 2
            let prefix = (count + 1) / 2
            let candidate = String(characters.prefix(prefix)) + "…" + String(characters.suffix(count - prefix))
            if self.measuredWidth(candidate) <= budget {
                fitted = candidate
                bounds.lower = count + 1
            } else {
                bounds.upper = count - 1
            }
        }
        return fitted
    }

    static func titleWidthBudget(
        hasImage: Bool = false,
        hasSubmenu: Bool = false,
        keyEquivalent: String = "") -> CGFloat
    {
        let cacheKey = "\(hasImage):\(hasSubmenu):\(keyEquivalent)"
        if let cachedWidth = self.chromeWidths[cacheKey] { return self.width - cachedWidth }
        let shortcut = keyEquivalent.isEmpty ? "q" : keyEquivalent
        let item = NSMenuItem(title: "M", action: nil, keyEquivalent: shortcut)
        item.image = NSImage(systemSymbolName: "circle", accessibilityDescription: nil)
        let cell = NSMenuItemCell(textCell: item.title)
        cell.menuItem = item
        cell.font = NSFont.menuFont(ofSize: 0)
        cell.calcSize()
        var chrome = cell.cellSize.width - self.measuredWidth(item.title)
        // AppKit aligns image, submenu, and shortcut columns across every item in the root menu.
        chrome += cell.stateImageWidth + self.measuredWidth("▶")
        chrome += cell.stateImageWidth + self.measuredWidth("⌘" + shortcut)
        self.chromeWidths[cacheKey] = chrome
        return self.width - chrome
    }

    private static func measuredWidth(_ value: String) -> CGFloat {
        (value as NSString).size(withAttributes: [.font: NSFont.menuFont(ofSize: 0)]).width
    }
}
