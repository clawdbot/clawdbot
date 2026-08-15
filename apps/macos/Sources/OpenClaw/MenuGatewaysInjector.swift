import AppKit

@MainActor
final class MenuGatewaysInjector: NSObject {
    static let shared = MenuGatewaysInjector()

    private let tag = 9_415_559

    func inject(into menu: NSMenu) {
        for item in menu.items where item.tag == self.tag {
            menu.removeItem(item)
        }

        let items = DashboardGatewayMenuModel.items(from: DashboardManager.shared.gatewayEntries)
        guard !items.isEmpty,
              var cursor = menu.items.lastIndex(where: \.isSeparatorItem)
        else {
            return
        }

        let header = NSMenuItem.sectionHeader(title: String(localized: "Gateways"))
        header.tag = self.tag
        menu.insertItem(header, at: cursor)
        cursor += 1

        for gateway in items {
            let item = NSMenuItem(
                title: gateway.name,
                action: #selector(self.openGateway(_:)),
                keyEquivalent: "")
            item.tag = self.tag
            item.target = self
            item.representedObject = gateway.id
            item.image = Self.healthImage(for: gateway.health, name: gateway.name)
            item.state = gateway.isPrimary ? .on : .off
            menu.insertItem(item, at: cursor)
            cursor += 1

            if gateway.canPromote {
                let alternate = NSMenuItem(
                    title: String(localized: "Set \(gateway.name) as Primary…"),
                    action: #selector(self.setPrimary(_:)),
                    keyEquivalent: "")
                alternate.tag = self.tag
                alternate.target = self
                alternate.representedObject = gateway.id
                alternate.isAlternate = true
                alternate.keyEquivalentModifierMask = [.option]
                menu.insertItem(alternate, at: cursor)
                cursor += 1
            }
        }
    }

    private static func healthImage(for health: DashboardGatewayHealth, name: String) -> NSImage? {
        let (symbolName, color): (String, NSColor) = switch health {
        case .ok:
            ("circle.fill", .systemGreen)
        case .error:
            ("exclamationmark.circle.fill", .systemRed)
        case .unknown:
            ("circle", .tertiaryLabelColor)
        }
        let accessibilityDescription = switch health {
        case .ok:
            String(localized: "\(name), healthy")
        case .error:
            String(localized: "\(name), health error")
        case .unknown:
            String(localized: "\(name), health unknown")
        }
        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityDescription)
        return image?.withSymbolConfiguration(.init(paletteColors: [color]))
    }

    @objc
    private func openGateway(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let target = DashboardGatewayTarget(bridgeID: id)
        else {
            return
        }
        DashboardManager.shared.openOrFocusDashboard(for: target)
    }

    @objc
    private func setPrimary(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let target = DashboardGatewayTarget(bridgeID: id)
        else {
            return
        }
        DashboardManager.shared.confirmSetPrimary(target)
    }
}
