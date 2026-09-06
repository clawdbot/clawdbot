import AppKit
import Observation
import OSLog
import SwiftUI

struct GatewayMenuEndpointLabels: Equatable {
    var endpointLabel: String?
    var transportLabel: String?

    static func primary(
        mode: AppState.ConnectionMode,
        transport: AppState.RemoteTransport,
        localPort: Int,
        sshTarget: String?,
        remoteURL: URL?,
        resolvedHostLabel: String?) -> Self
    {
        switch mode {
        case .unconfigured:
            return Self()
        case .local:
            return Self(endpointLabel: "localhost:\(localPort)")
        case .remote:
            if transport == .ssh {
                let host = DashboardGatewayCatalog.primaryRemoteHostLabel(
                    transport: transport,
                    sshTarget: sshTarget,
                    resolvedHostLabel: resolvedHostLabel)
                return Self(endpointLabel: host.map { String(format: String(localized: "%@ via ssh"), $0) })
            }
            return Self(endpointLabel: remoteURL.flatMap(self.hostLabel) ?? resolvedHostLabel)
        }
    }

    static func profile(_ item: MacGatewayCatalogProfile) -> Self {
        let transport: String? = if item.usesBrowserIdentity {
            String(localized: "Access")
        } else {
            switch item.authKind {
            case .browser: String(localized: "Access")
            case .token: String(localized: "token")
            case .password: String(localized: "password")
            case nil: nil
            }
        }
        return Self(endpointLabel: Self.hostLabel(item.profile.url), transportLabel: transport)
    }

    private static func hostLabel(_ url: URL) -> String? {
        guard let host = url.host else { return nil }
        let defaultPort = ["wss", "https"].contains(url.scheme?.lowercased() ?? "") ? 443 : 80
        guard let port = url.port, port != defaultPort else { return host }
        return "\(host):\(port)"
    }
}

@MainActor
final class GatewaysMainMenu: NSObject, NSMenuDelegate {
    static let shared = GatewaysMainMenu()

    private let logger = Logger(subsystem: "ai.openclaw", category: "GatewaysMainMenu")
    private lazy var store = GatewayMenuStatusStore(disconnectProfile: { [weak self] profileID in
        await self?.disconnectIdleProfile(profileID)
    })
    private var windowOpens: [UUID: (target: DashboardGatewayTarget, task: Task<Void, Never>)] = [:]
    private weak var menu: NSMenu?
    private var installed = false
    private var loggedMissingMenu = false
    private var isMenuOpen = false
    private var refreshTask: Task<Void, Never>?
    private var openingID: UUID?
    private var rows: [(gateway: DashboardGatewayMenuItem, item: NSMenuItem)] = []
    private var profiles: [String: MacGatewayCatalogProfile] = [:]
    private var primaryLabels = GatewayMenuEndpointLabels()

    func install() {
        guard !self.installed else { return }
        self.installed = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.mainMenuBeganTracking(_:)),
            name: NSMenu.didBeginTrackingNotification,
            object: nil)
        self.observeGatewayChanges()
        if !self.attachSubmenu() {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.attachSubmenu() else { return }
                self.reportMissingMenu()
            }
        }
    }

    private func attachSubmenu() -> Bool {
        guard let submenu = NSApp.mainMenu?.items.first(where: {
            $0.title == String(localized: "Gateways")
        })?.submenu else { return false }
        guard self.menu !== submenu || submenu.delegate !== self else { return true }
        // SwiftUI continues to own the top-level CommandMenu and its position.
        self.menu = submenu
        submenu.delegate = self
        submenu.autoenablesItems = false
        submenu.minimumWidth = StatusMenuMetrics.width
        self.menuNeedsUpdate(submenu)
        return true
    }

    @objc private func mainMenuBeganTracking(_ notification: Notification) {
        guard let trackingMenu = notification.object as? NSMenu, trackingMenu === NSApp.mainMenu else { return }
        if !self.attachSubmenu() {
            self.reportMissingMenu()
        }
    }

    private func reportMissingMenu() {
        guard !self.loggedMissingMenu else { return }
        self.loggedMissingMenu = true
        self.logger.error("SwiftUI Gateways menu is unavailable; retrying when the main menu begins tracking")
    }

    private func observeGatewayChanges() {
        withObservationTracking {
            _ = DashboardManager.shared.gatewayEntries
            _ = DashboardManager.shared.frontmostDashboardTarget
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let menu = self.menu {
                    self.menuNeedsUpdate(menu)
                }
                self.observeGatewayChanges()
            }
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard !self.isMenuOpen else {
            self.updateCards()
            return
        }
        let gateways = DashboardGatewayMenuModel.items(from: DashboardManager.shared.gatewayEntries)
        menu.removeAllItems()
        self.rows.removeAll()
        for gateway in gateways {
            let key = gateway.shortcutNumber.map(String.init) ?? ""
            let item = NSMenuItem(title: gateway.name, action: #selector(self.openGateway(_:)), keyEquivalent: key)
            item.target = self
            item.identifier = NSUserInterfaceItemIdentifier(gateway.id)
            item.keyEquivalentModifierMask = [.command]
            menu.addItem(item)
            self.rows.append((gateway, item))

            let alternate = NSMenuItem(
                title: String(format: String(localized: "New %@ Window"), gateway.name),
                action: #selector(self.newGatewayWindow(_:)),
                keyEquivalent: key)
            alternate.target = self
            alternate.identifier = item.identifier
            alternate.isAlternate = true
            alternate.keyEquivalentModifierMask = [.command, .option]
            menu.addItem(alternate)
            if gateway.isPrimary, gateways.contains(where: { !$0.isPrimary }) {
                menu.addItem(.separator())
            }
        }
        if !gateways.isEmpty {
            menu.addItem(.separator())
        }
        let manage = NSMenuItem(
            title: String(localized: "Manage Gateways…"),
            action: #selector(self.manageGateways(_:)),
            keyEquivalent: "")
        manage.target = self
        menu.addItem(manage)
        self.updateCards()
    }

    func menuWillOpen(_: NSMenu) {
        guard !self.isMenuOpen else { return }
        self.isMenuOpen = true
        let openingID = UUID()
        self.openingID = openingID
        let state = AppStateStore.shared
        let connectivity = GatewayConnectivityCoordinator.shared
        self.primaryLabels = GatewayMenuEndpointLabels.primary(
            mode: state.connectionMode,
            transport: state.remoteTransport,
            localPort: GatewayEnvironment.gatewayPort(),
            sshTarget: state.remoteTarget,
            remoteURL: connectivity.resolvedURL ?? URL(string: state.remoteUrl),
            resolvedHostLabel: connectivity.resolvedHostLabel)
        self.updateCards()
        self.refreshTask = Task { [weak self] in
            await DashboardManager.shared.refreshGatewaySnapshots()
            guard let self, !Task.isCancelled, self.openingID == openingID else { return }
            do {
                let profiles = try await MacGatewayProfileStore.shared.catalogProfiles()
                guard !Task.isCancelled, self.openingID == openingID else { return }
                self.profiles = Dictionary(uniqueKeysWithValues: profiles.map { ($0.profile.id, $0) })
            } catch {
                guard !Task.isCancelled, self.openingID == openingID else { return }
                self.logger.error("Could not load Gateway menu profile metadata")
            }
            let targets = DashboardGatewayMenuModel.items(from: DashboardManager.shared.gatewayEntries).map(\.target)
            self.store.beginProbing(targets: targets) { [weak self] in
                guard let self, self.openingID == openingID else { return }
                self.updateCards()
            }
            self.updateCards()
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        self.isMenuOpen = false
        self.openingID = nil
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.store.endProbing { DashboardManager.shared.openWindowCount(for: $0) }
        StatusMenuHighlightDelegate.shared.menuDidClose(menu)
    }

    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        StatusMenuHighlightDelegate.shared.menu(menu, willHighlight: item)
    }

    private func updateCards() {
        let dashboard = DashboardManager.shared
        let now = Date()
        for (gateway, item) in self.rows {
            let facts = self.store.facts[gateway.target]
            let profile: MacGatewayCatalogProfile? = if case let .profile(id) = gateway.target {
                self.profiles[id]
            } else {
                nil
            }
            let labels = gateway.isPrimary ? self.primaryLabels : profile.map(GatewayMenuEndpointLabels.profile)
            let model = GatewayMenuCardModel(
                name: gateway.name,
                isPrimary: gateway.isPrimary,
                isFrontmost: dashboard.frontmostDashboardTarget == gateway.target,
                shortcutNumber: gateway.shortcutNumber,
                health: facts?.health ?? gateway.health,
                version: facts?.version,
                buildId: facts?.buildId,
                endpointLabel: labels?.endpointLabel,
                transportLabel: labels?.transportLabel,
                latencyMs: facts?.latencyMs,
                windowCount: dashboard.openWindowCount(for: gateway.target),
                browserSessionExpiresAt: profile?.browserSessionExpiresAt,
                lastSeen: facts?.lastSeen,
                isProbing: self.store.isProbing(gateway.target))
            let card = GatewayMenuCard(model: model, now: now)
                .contentShape(Rectangle())
                .onTapGesture { [weak self, weak item] in
                    guard let self, let item else { return }
                    item.menu?.cancelTracking()
                    self.openGateway(item)
                }
                .accessibilityAction { [weak self, weak item] in
                    guard let self, let item else { return }
                    item.menu?.cancelTracking()
                    self.openGateway(item)
                }
            StatusMenuRenderer.configureHostedView(item, rootView: card, highlights: true)
        }
    }

    @objc private func openGateway(_ sender: NSMenuItem) {
        guard let id = sender.identifier?.rawValue, let target = DashboardGatewayTarget(bridgeID: id) else { return }
        self.trackWindowOpen(target: target, task: DashboardManager.shared.openOrFocusDashboard(for: target))
    }

    @objc private func newGatewayWindow(_ sender: NSMenuItem) {
        guard let id = sender.identifier?.rawValue, let target = DashboardGatewayTarget(bridgeID: id) else { return }
        self.trackWindowOpen(target: target, task: DashboardManager.shared.openNewDashboardWindow(for: target))
    }

    private func trackWindowOpen(target: DashboardGatewayTarget, task: Task<Void, Never>) {
        let id = UUID()
        self.windowOpens[id] = (target, task)
        Task { [weak self] in
            await task.value
            self?.windowOpens[id] = nil
        }
    }

    private func disconnectIdleProfile(_ profileID: String) async {
        let target = DashboardGatewayTarget.profile(profileID)
        // AppKit closes tracking before dispatching an item action. A selected
        // dashboard owns its connection while its async window setup finishes.
        while let opening = self.windowOpens.first(where: { $0.value.target == target }) {
            await opening.value.task.value
            guard !Task.isCancelled else { return }
            self.windowOpens[opening.key] = nil
        }
        guard !Task.isCancelled, DashboardManager.shared.openWindowCount(for: target) == 0 else { return }
        await MacGatewayConnectionFleet.shared.disconnect(profileID: profileID, ifCurrent: { !Task.isCancelled })
    }

    @objc private func manageGateways(_: NSMenuItem) {
        AppNavigationActions.openConnection(tab: .gateways)
    }
}
