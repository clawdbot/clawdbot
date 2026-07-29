import AppKit
import WebKit

final class DashboardWebView: WKWebView {
    private static let hiddenContextMenuIdentifiers: Set<String> = [
        "WKMenuItemIdentifierReload",
        "WKMenuItemIdentifierOpenLinkInNewWindow",
        "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierOpenFrameInNewWindow",
        "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierDownloadMedia",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let items = Self.filteredContextMenuItems(menu.items)
        menu.removeAllItems()
        for item in items {
            menu.addItem(item)
        }
    }

    static func filteredContextMenuItems(_ items: [NSMenuItem]) -> [NSMenuItem] {
        var filtered: [NSMenuItem] = []
        for item in items where !Self.hiddenContextMenuIdentifiers.contains(item.identifier?.rawValue ?? "") {
            if item.isSeparatorItem, filtered.last?.isSeparatorItem != false {
                continue
            }
            filtered.append(item)
        }
        if filtered.last?.isSeparatorItem == true {
            filtered.removeLast()
        }
        return filtered
    }
}
