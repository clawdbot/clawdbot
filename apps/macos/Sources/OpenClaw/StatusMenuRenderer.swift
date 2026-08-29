import AppKit
import Foundation
import KeyboardShortcuts
import OpenClawKit
import QuartzCore
import SwiftUI

@MainActor
final class HostedMenuRowView: NSView {
    private var content: AnyView
    private let hosting: NSHostingView<AnyView>
    private let selection = NSVisualEffectView()

    var isHighlighted = false {
        didSet {
            guard self.isHighlighted != oldValue else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self.selection.isHidden = !self.isHighlighted
            self.hosting.rootView = AnyView(self.content.environment(\.menuItemHighlighted, self.isHighlighted))
            CATransaction.commit()
        }
    }

    init(rootView: AnyView) {
        self.content = rootView
        self.hosting = NSHostingView(rootView: AnyView(rootView.environment(\.menuItemHighlighted, false)))
        super.init(frame: .zero)

        self.selection.material = .selection
        self.selection.blendingMode = .behindWindow
        self.selection.isEmphasized = true
        self.selection.state = .active
        self.selection.wantsLayer = true
        self.selection.layer?.cornerRadius = 5
        self.selection.layer?.masksToBounds = true
        self.selection.isHidden = true
        self.addSubview(self.selection)
        self.addSubview(self.hosting)
        self.update(rootView: rootView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: StatusMenuMetrics.width, height: self.hosting.fittingSize.height)
    }

    override func layout() {
        super.layout()
        self.selection.frame = self.bounds.insetBy(dx: 5, dy: 1)
        self.hosting.frame = self.bounds
    }

    func update(rootView: AnyView) {
        self.content = rootView
        self.hosting.rootView = AnyView(rootView.environment(\.menuItemHighlighted, self.isHighlighted))
        self.hosting.invalidateIntrinsicContentSize()
        self.frame = NSRect(
            origin: .zero,
            size: NSSize(width: StatusMenuMetrics.width, height: self.hosting.fittingSize.height))
        self.invalidateIntrinsicContentSize()
        self.needsLayout = true
    }
}

@MainActor
final class StatusMenuHighlightDelegate: NSObject, NSMenuDelegate {
    static let shared = StatusMenuHighlightDelegate()

    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        for candidate in menu.items {
            (candidate.view as? HostedMenuRowView)?.isHighlighted = candidate === item && candidate.isEnabled
        }
    }

    /// AppKit does not send willHighlight(nil) when a submenu closes, so a
    /// hosted row selected there would reopen still lit without this reset.
    func menuDidClose(_ menu: NSMenu) {
        self.menu(menu, willHighlight: nil)
    }
}

@MainActor
final class StatusMenuRenderer: NSObject {
    private enum RenderEntry {
        case content(StatusMenuDescriptor.Entry)
        case separator(String)

        var id: String {
            switch self {
            case let .content(entry): entry.id
            case let .separator(id): id
            }
        }

        var isSeparator: Bool {
            if case .separator = self {
                return true
            }
            return false
        }
    }

    private let menu: NSMenu
    private let state: AppState
    private var testNotificationPending = false
    var isSleeping = false
    var onInstallUpdate: (@MainActor () -> Void)?

    init(menu: NSMenu, state: AppState = AppStateStore.shared) {
        self.menu = menu
        self.state = state
        super.init()
        menu.autoenablesItems = false
        menu.minimumWidth = StatusMenuMetrics.width
        StatusMenuAppearance.pin(menu)
    }

    func render(_ descriptor: StatusMenuDescriptor) {
        self.reconcile(descriptor)
    }

    func reconcile(_ descriptor: StatusMenuDescriptor) {
        let entries = self.flatten(descriptor)
        let liveItems = self.menu.items

        func matches(_ item: NSMenuItem, _ entry: RenderEntry) -> Bool {
            item.isSeparatorItem == entry.isSeparator && item.representedObject as? String == entry.id
        }

        var prefix = 0
        while prefix < min(liveItems.count, entries.count), matches(liveItems[prefix], entries[prefix]) {
            prefix += 1
        }

        var suffix = 0
        while suffix < min(liveItems.count, entries.count) - prefix,
              matches(liveItems[liveItems.count - suffix - 1], entries[entries.count - suffix - 1])
        {
            suffix += 1
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        for index in 0..<prefix {
            self.configure(liveItems[index], as: entries[index])
        }
        for offset in 0..<suffix {
            self.configure(
                liveItems[liveItems.count - offset - 1],
                as: entries[entries.count - offset - 1])
        }

        // Preserve the tracked prefix/suffix so AppKit never observes an empty open menu.
        for _ in 0..<(liveItems.count - prefix - suffix) {
            self.menu.removeItem(at: prefix)
        }
        for (offset, entry) in entries[prefix..<(entries.count - suffix)].enumerated() {
            self.menu.insertItem(self.makeItem(for: entry), at: prefix + offset)
        }
    }

    private func flatten(_ descriptor: StatusMenuDescriptor) -> [RenderEntry] {
        var entries: [RenderEntry] = []
        for section in descriptor.sections where !section.entries.isEmpty {
            if !entries.isEmpty {
                entries.append(.separator("separator.\(section.id)"))
            }
            entries.append(contentsOf: section.entries.map(RenderEntry.content))
        }
        return entries
    }

    private func makeItem(for entry: RenderEntry) -> NSMenuItem {
        let item = switch entry {
        case .separator:
            NSMenuItem.separator()
        case let .content(content):
            if case .gatewayHeader = content.kind {
                NSMenuItem.sectionHeader(title: String(localized: "Gateways"))
            } else {
                NSMenuItem()
            }
        }
        item.representedObject = entry.id
        self.configure(item, as: entry)
        return item
    }

    private func configure(_ item: NSMenuItem, as entry: RenderEntry) {
        guard case let .content(content) = entry else { return }
        item.representedObject = content.id

        switch content.kind {
        case .header:
            Self.configureHostedView(
                item, rootView: StatusMenuHeaderView(state: self.state, isSleeping: self.isSleeping))
        case let .session(row):
            StatusMenuSessions.shared.configureSessionItem(item, row: row)
        case let .approval(request):
            StatusMenuSessions.shared.configureApprovalItem(item, request: request)
        case let .placeholder(title):
            item.title = StatusMenuMetrics.fittedTitle(title)
            item.isEnabled = false
        case let .action(action):
            self.configureAction(item, action: action)
        case let .summary(summary):
            switch summary {
            case .automations: StatusMenuSummaries.shared.configureAutomations(item)
            case .usage: StatusMenuSummaries.shared.configureUsage(item)
            case .devices: StatusMenuSummaries.shared.configureDevices(item)
            }
        case let .gateway(gateway, isAlternate):
            StatusMenuSummaries.shared.configureGateway(item, gateway: gateway, isAlternate: isAlternate)
        case .gatewayHeader:
            item.title = String(localized: "Gateways")
        case .updateReady:
            self.configureNative(
                item,
                title: String(localized: "Update ready, restart now?"),
                symbol: "arrow.down.circle",
                action: #selector(self.installUpdate(_:)))
        }
    }

    static func configureHostedView(_ item: NSMenuItem, rootView: some View, highlights: Bool = false) {
        let rootView = AnyView(rootView.frame(width: StatusMenuMetrics.width, alignment: .leading))
        if highlights {
            if let existing = item.view as? HostedMenuRowView {
                existing.update(rootView: rootView)
            } else {
                item.view = HostedMenuRowView(rootView: rootView)
            }
            return
        }

        let hosting: NSHostingView<AnyView>
        if let existing = item.view as? NSHostingView<AnyView> {
            // Keep the attached view stable while AppKit tracks an open menu.
            existing.rootView = rootView
            existing.invalidateIntrinsicContentSize()
            hosting = existing
        } else {
            hosting = NSHostingView(rootView: rootView)
            item.view = hosting
        }
        hosting.frame = NSRect(
            origin: .zero,
            size: NSSize(width: StatusMenuMetrics.width, height: hosting.fittingSize.height))
    }

    private func configureAction(_ item: NSMenuItem, action: StatusMenuDescriptor.Action) {
        let title: String
        let symbol: String

        switch action {
        case .dashboard:
            title = String(localized: "Open Dashboard")
            symbol = "gauge"
        case .quickChat:
            title = String(localized: "Quick Chat")
            symbol = "text.bubble"
        case .talkMode:
            title = self.state.talkEnabled
                ? String(localized: "Stop Talk Mode")
                : String(localized: "Start Talk Mode")
            symbol = "waveform.circle.fill"
        case .allSessions:
            title = String(localized: "All Sessions…")
            symbol = "rectangle.stack"
        case .settings:
            title = String(localized: "Settings…")
            symbol = "gearshape"
        case .debug:
            title = String(localized: "Debug")
            symbol = "ladybug"
        case .about:
            title = String(localized: "About OpenClaw")
            symbol = "info.circle"
        case .quit:
            title = String(localized: "Quit")
            symbol = "power"
        }

        self.configureNative(item, title: title, symbol: symbol, action: #selector(self.performAction(_:)))
        item.isEnabled = action != .talkMode || voiceWakeSupported
        item.keyEquivalent = ""

        switch action {
        case .settings:
            item.keyEquivalent = ","
            item.keyEquivalentModifierMask = [.command]
        case .quit:
            item.keyEquivalent = "q"
            item.keyEquivalentModifierMask = [.command]
        case .quickChat:
            if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleQuickChat),
               let key = shortcut.nsMenuItemKeyEquivalent
            {
                item.keyEquivalent = key
                item.keyEquivalentModifierMask = shortcut.modifiers
            }
        case .debug:
            self.configureDebugMenu(item)
        default:
            break
        }
    }

    private func configureNative(_ item: NSMenuItem, title: String, symbol: String, action: Selector) {
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        item.title = StatusMenuMetrics.fittedTitle(title)
        item.target = self
        item.action = action
        item.isEnabled = true
    }

    @objc private func performAction(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let action = StatusMenuDescriptor.Action(rawValue: String(id.dropFirst("action.".count)))
        else { return }

        switch action {
        case .dashboard:
            AppNavigationActions.openDashboard()
        case .quickChat:
            QuickChatController.shared.toggle()
        case .talkMode:
            Task { await self.state.setTalkEnabled(!self.state.talkEnabled) }
        case .allSessions:
            Task { await DashboardManager.shared.show(atPath: DashboardRouteMap.sessionsPagePath) }
        case .settings:
            AppNavigationActions.openSettings()
        case .about:
            AppNavigationActions.openSettings(tab: .about)
        case .quit:
            AppDelegate.requestTermination()
        case .debug:
            break
        }
    }

    @objc private func installUpdate(_: NSMenuItem) {
        self.onInstallUpdate?()
    }

    private func configureDebugMenu(_ item: NSMenuItem) {
        let submenu = item.submenu ?? NSMenu(title: String(localized: "Debug"))
        submenu.autoenablesItems = false
        StatusMenuAppearance.pin(submenu)

        var entries = [
            debugItem("config", String(localized: "Open Config Folder"), "folder"),
            debugItem("health", String(localized: "Run Health Check Now"), "stethoscope"),
            debugItem("heartbeat", String(localized: "Send Test Heartbeat"), "waveform.path.ecg"),
        ]

        #if DEBUG
        entries.append(self.debugItem(
            "pairing",
            String(localized: "Show Pairing Panel (Demo)"),
            "checkmark.shield"))
        #endif

        if self.state.connectionMode == .remote {
            entries.append(self.debugItem(
                "tunnel",
                String(localized: "Reset Remote Tunnel"),
                "arrow.triangle.2.circlepath"))
        }

        let verboseTitle = DebugActions.verboseLoggingEnabledMain
            ? String(localized: "Verbose Logging (Main): On")
            : String(localized: "Verbose Logging (Main): Off")
        entries.append(self.debugItem("verbose", verboseTitle, "text.alignleft"))

        let logging = self.debugItem("logging", String(localized: "App Logging"), "doc.text")
        self.configureLoggingMenu(logging)
        entries.append(logging)
        entries.append(self.debugItem("sessions", String(localized: "Open Session Store"), "externaldrive"))
        entries.append(self.debugSeparator("inspect"))
        entries.append(self.debugItem("events", String(localized: "Open Agent Events…"), "bolt.horizontal.circle"))
        entries.append(self.debugItem("log", String(localized: "Open Log"), "doc.text.magnifyingglass"))
        entries.append(self.debugItem("voice", String(localized: "Send Debug Voice Text"), "waveform.circle"))

        let notification = self.debugItem("notification", String(localized: "Send Test Notification"), "bell")
        notification.isEnabled = !self.testNotificationPending
        entries.append(notification)
        entries.append(self.debugSeparator("restart"))

        if self.state.connectionMode == .local {
            entries.append(self.debugItem("gateway", String(localized: "Restart Gateway"), "arrow.clockwise"))
        }
        entries.append(self.debugItem(
            "onboarding",
            String(localized: "Restart Onboarding"),
            "arrow.counterclockwise"))
        entries.append(self.debugItem("app", String(localized: "Restart App"), "arrow.triangle.2.circlepath"))

        self.reconcileNativeMenu(submenu, with: entries)
        item.submenu = submenu
    }

    private func configureLoggingMenu(_ item: NSMenuItem) {
        let submenu = item.submenu ?? NSMenu(title: String(localized: "App Logging"))
        submenu.autoenablesItems = false
        StatusMenuAppearance.pin(submenu)

        var entries = Logger.Level.allCases.map { level in
            let entry = self.debugItem("level.\(level.rawValue)", level.title, "slider.horizontal.3")
            entry.state = AppLogSettings.logLevel() == level ? .on : .off
            return entry
        }

        entries.append(self.debugSeparator("logging"))
        let enabled = AppLogSettings.fileLoggingEnabled()
        let title = enabled ? String(localized: "File Logging: On") : String(localized: "File Logging: Off")
        let fileLogging = self.debugItem("fileLogging", title, "doc.text.magnifyingglass")
        fileLogging.state = enabled ? .on : .off
        entries.append(fileLogging)

        self.reconcileNativeMenu(submenu, with: entries)
        item.submenu = submenu
    }

    private func debugItem(_ id: String, _ title: String, _ symbol: String) -> NSMenuItem {
        let item = NSMenuItem()
        item.representedObject = "debug.\(id)"
        self.configureNative(item, title: title, symbol: symbol, action: #selector(self.performDebugAction(_:)))
        return item
    }

    private func debugSeparator(_ id: String) -> NSMenuItem {
        let item = NSMenuItem.separator()
        item.representedObject = "debug.separator.\(id)"
        return item
    }

    private func reconcileNativeMenu(_ menu: NSMenu, with desired: [NSMenuItem]) {
        var index = 0
        while index < desired.count {
            let candidate = desired[index]
            let candidateID = candidate.representedObject as? String

            if index < menu.items.count,
               menu.items[index].representedObject as? String == candidateID
            {
                let existing = menu.items[index]
                if !existing.isSeparatorItem {
                    existing.title = candidate.title
                    existing.image = candidate.image
                    existing.state = candidate.state
                    existing.isEnabled = candidate.isEnabled
                    existing.action = candidate.action
                    existing.target = candidate.target
                    if let desiredSubmenu = candidate.submenu {
                        if let existingSubmenu = existing.submenu {
                            self.reconcileNativeMenu(existingSubmenu, with: desiredSubmenu.items)
                        } else {
                            candidate.submenu = nil
                            existing.submenu = desiredSubmenu
                        }
                    }
                }
            } else {
                if let oldIndex = menu.items.firstIndex(where: { $0.representedObject as? String == candidateID }) {
                    for _ in index..<oldIndex {
                        menu.removeItem(at: index)
                    }
                    continue
                }
                candidate.menu?.removeItem(candidate)
                menu.insertItem(candidate, at: index)
            }
            index += 1
        }
        while menu.items.count > desired.count {
            menu.removeItem(at: desired.count)
        }
    }

    @objc private func performDebugAction(_ sender: NSMenuItem) {
        guard let represented = sender.representedObject as? String else { return }
        let id = String(represented.dropFirst("debug.".count))

        if id.hasPrefix("level."), let level = Logger.Level(rawValue: String(id.dropFirst("level.".count))) {
            AppLogSettings.setLogLevel(level)
            sender.menu?.items.forEach { item in
                if (item.representedObject as? String)?.hasPrefix("debug.level.") == true {
                    item.state = item === sender ? .on : .off
                }
            }
            return
        }

        switch id {
        case "config": DebugActions.openConfigFolder()
        case "health": Task { await DebugActions.runHealthCheckNow() }
        case "heartbeat": Task { _ = await DebugActions.sendTestHeartbeat() }
        case "pairing":
            #if DEBUG
            DebugActions.showPairingPanelDemo()
            #endif
        case "tunnel":
            Task { await self.presentTunnelResult() }
        case "verbose":
            Task { _ = await DebugActions.toggleVerboseLoggingMain() }
        case "fileLogging":
            let enabled = !AppLogSettings.fileLoggingEnabled()
            AppDefaults.standard.set(enabled, forKey: debugFileLogEnabledKey)
            sender.state = enabled ? .on : .off
            sender.title = enabled ? String(localized: "File Logging: On") : String(localized: "File Logging: Off")
        case "sessions": DebugActions.openSessionStore()
        case "events": DebugActions.openAgentEventsWindow()
        case "log": DebugActions.openLog()
        case "voice": Task { _ = await DebugActions.sendDebugVoice() }
        case "notification": Task { await self.sendTestNotification(sender) }
        case "gateway": DebugActions.restartGateway()
        case "onboarding": DebugActions.restartOnboarding()
        case "app": DebugActions.restartApp()
        default: break
        }
    }

    private func presentTunnelResult() async {
        let result = await DebugActions.resetGatewayTunnel()
        let alert = NSAlert()
        alert.messageText = String(localized: "Remote Tunnel")
        switch result {
        case let .success(message):
            alert.informativeText = message
            alert.alertStyle = .informational
        case let .failure(error):
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
        }
        alert.runModal()
    }

    private func sendTestNotification(_ sender: NSMenuItem) async {
        guard !self.testNotificationPending else { return }
        self.testNotificationPending = true
        sender.isEnabled = false
        let outcome = await DebugActions.sendTestNotification()
        self.testNotificationPending = false
        sender.isEnabled = true

        let alert = NSAlert()
        alert.messageText = String(localized: "Test Notification")
        switch outcome {
        case .pending: return
        case .sent:
            alert.informativeText = String(localized: "The notification request was queued.")
            alert.alertStyle = .informational
        case let .error(message):
            alert.informativeText = message
            alert.alertStyle = .warning
        }
        alert.runModal()
    }
}
