import AppKit
import Testing
@testable import OpenClaw

@MainActor
struct StatusMenuReconcileTests {
    @Test func `AppKit selection highlights only the selected hosted session row`() throws {
        // Highlighting needs real hosted rows, not live session submenus that fetch previews.
        let menu = NSMenu()
        menu.delegate = StatusMenuHighlightDelegate.shared
        let first = self.hostedSessionItem("first")
        let second = self.hostedSessionItem("second")
        menu.addItem(first)
        menu.addItem(second)
        let firstHosted = try #require(first.view as? HostedMenuRowView)
        let secondHosted = try #require(second.view as? HostedMenuRowView)

        menu.delegate?.menu?(menu, willHighlight: first)
        #expect(firstHosted.isHighlighted)
        #expect(!secondHosted.isHighlighted)

        menu.delegate?.menu?(menu, willHighlight: second)
        #expect(!firstHosted.isHighlighted)
        #expect(secondHosted.isHighlighted)

        menu.delegate?.menu?(menu, willHighlight: nil)
        #expect(!firstHosted.isHighlighted)
        #expect(!secondHosted.isHighlighted)

        let submenu = NSMenu()
        submenu.delegate = StatusMenuHighlightDelegate.shared
        first.submenu = submenu
        let nested = self.hostedSessionItem("nested")
        submenu.addItem(nested)
        let nestedHosted = try #require(nested.view as? HostedMenuRowView)

        submenu.delegate?.menu?(submenu, willHighlight: nested)
        #expect(nestedHosted.isHighlighted)
        submenu.delegate?.menuDidClose?(submenu)
        #expect(!nestedHosted.isHighlighted)

        menu.delegate?.menu?(menu, willHighlight: second)
        #expect(secondHosted.isHighlighted)
        // A closing submenu never receives willHighlight(nil); the delegate's
        // close callback must clear the lingering hosted selection itself.
        StatusMenuHighlightDelegate.shared.menuDidClose(menu)
        #expect(!secondHosted.isHighlighted)
        #expect(!firstHosted.isHighlighted)
    }

    @Test func `matching rows update titles without replacing tracked items`() throws {
        let menu = NSMenu()
        let renderer = StatusMenuRenderer(menu: menu)
        renderer.render(self.descriptor(
            actions: [.placeholder(String(localized: "Connecting…"))],
            footer: [.action(.settings)]))

        let placeholder = try #require(menu.items.first { $0.representedObject as? String == "placeholder" })
        let separator = try #require(menu.items.first { $0.representedObject as? String == "separator.footer" })
        let settings = try #require(menu.items.first { $0.representedObject as? String == "action.settings" })

        renderer.reconcile(self.descriptor(
            actions: [.placeholder(String(localized: "Gateway disconnected"))],
            footer: [.action(.settings)]))

        #expect(menu.items[0] === placeholder)
        #expect(menu.items[0].title == String(localized: "Gateway disconnected"))
        #expect(menu.items[1] === separator)
        #expect(menu.items[2] === settings)
    }

    @Test func `structural changes replace only the differing middle span`() throws {
        let menu = NSMenu()
        let renderer = StatusMenuRenderer(menu: menu)
        renderer.render(self.descriptor(
            actions: [.action(.dashboard), .placeholder(String(localized: "Connecting…"))],
            footer: [.action(.settings), .action(.about), .action(.quit)]))

        let dashboard = try #require(menu.items.first { $0.representedObject as? String == "action.dashboard" })
        let removed = try #require(menu.items.first { $0.representedObject as? String == "placeholder" })
        let separator = try #require(menu.items.first { $0.representedObject as? String == "separator.footer" })
        let footer = Array(menu.items.suffix(3))

        renderer.reconcile(self.descriptor(
            actions: [.action(.dashboard), .action(.quickChat), .action(.talkMode)],
            footer: [.action(.settings), .action(.about), .action(.quit)]))

        #expect(menu.items.map { $0.representedObject as? String } == [
            "action.dashboard",
            "action.quickChat",
            "action.talkMode",
            "separator.footer",
            "action.settings",
            "action.about",
            "action.quit",
        ])
        #expect(menu.items[0] === dashboard)
        #expect(menu.items[3] === separator)
        #expect(zip(menu.items.suffix(3), footer).allSatisfy { $0.0 === $0.1 })
        #expect(removed.menu == nil)
    }

    @Test func `removing a middle section preserves later separator identity`() throws {
        let menu = NSMenu()
        let renderer = StatusMenuRenderer(menu: menu)
        renderer.render(StatusMenuDescriptor(sections: [
            .init(id: "actions", entries: [.init(.action(.dashboard))]),
            .init(id: "middle", entries: [.init(.action(.talkMode))]),
            .init(id: "footer", entries: [.init(.action(.settings)), .init(.action(.quit))]),
        ]))

        let dashboard = try #require(menu.items.first { $0.representedObject as? String == "action.dashboard" })
        let footerSeparator = try #require(menu.items.first {
            $0.representedObject as? String == "separator.footer"
        })
        let settings = try #require(menu.items.first { $0.representedObject as? String == "action.settings" })

        renderer.reconcile(self.descriptor(
            actions: [.action(.dashboard)],
            footer: [.action(.settings), .action(.quit)]))

        #expect(menu.items[0] === dashboard)
        #expect(menu.items[1] === footerSeparator)
        #expect(menu.items[2] === settings)
        #expect(!menu.items.contains { $0.representedObject as? String == "separator.middle" })
    }

    private func descriptor(
        actions: [StatusMenuDescriptor.Kind],
        footer: [StatusMenuDescriptor.Kind]) -> StatusMenuDescriptor
    {
        StatusMenuDescriptor(sections: [
            .init(id: "actions", entries: actions.map(StatusMenuDescriptor.Entry.init)),
            .init(id: "footer", entries: footer.map(StatusMenuDescriptor.Entry.init)),
        ])
    }

    private func hostedSessionItem(_ key: String) -> NSMenuItem {
        let item = NSMenuItem()
        StatusMenuRenderer.configureHostedView(
            item,
            rootView: StatusSessionCard(row: self.session(key)),
            highlights: true)
        return item
    }

    private func session(_ key: String) -> SessionRow {
        SessionRow(
            id: key,
            key: key,
            kind: .direct,
            displayName: nil,
            updatedAt: Date(),
            sessionId: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            systemSent: false,
            abortedLastRun: false,
            tokens: SessionTokenStats(input: 0, output: 0, total: 0, contextTokens: 200_000),
            model: nil)
    }
}
