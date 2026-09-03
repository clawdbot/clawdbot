import AppKit

/// Single owner of the status menu's width. Every row - hosted card or native
/// item - is built to this width, so the menu never sizes itself from content.
@MainActor
enum StatusMenuMetrics {
    static let width: CGFloat = 330

    /// Truncates a native row title to the width budget with a middle ellipsis.
    /// Hosted cards do not need this: the renderer frames them at `width`.
    static func fittedTitle(_ title: String) -> String {
        let budget = self.titleWidthBudget
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

    /// AppKit aligns the image, submenu, and shortcut columns across every item
    /// in a menu, so the budget is menu-wide rather than per item: this menu
    /// always carries all three (icons on actions, submenus on sessions and
    /// summaries, shortcuts on Settings and Quit).
    static let titleWidthBudget: CGFloat = {
        let probe = NSMenuItem(title: "M", action: nil, keyEquivalent: "q")
        probe.image = NSImage(systemSymbolName: "circle", accessibilityDescription: nil)
        let cell = NSMenuItemCell(textCell: probe.title)
        cell.menuItem = probe
        cell.font = NSFont.menuFont(ofSize: 0)
        cell.calcSize()
        var chrome = cell.cellSize.width - StatusMenuMetrics.measuredWidth(probe.title)
        chrome += cell.stateImageWidth + StatusMenuMetrics.measuredWidth("▶")
        chrome += cell.stateImageWidth + StatusMenuMetrics.measuredWidth("⌘q")
        return StatusMenuMetrics.width - chrome
    }()

    private static func measuredWidth(_ value: String) -> CGFloat {
        (value as NSString).size(withAttributes: [.font: NSFont.menuFont(ofSize: 0)]).width
    }
}
