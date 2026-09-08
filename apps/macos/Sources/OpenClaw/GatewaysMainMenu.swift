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

    private struct RowSignature: Equatable {
        let id: String
        let name: String
        let shortcutNumber: Int?
        let isPrimary: Bool

        init(_ gateway: DashboardGatewayMenuItem) {
            self.id = gateway.id
            self.name = gateway.name
            self.shortcutNumber = gateway.shortcutNumber
            self.isPrimary = gateway.isPrimary
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "GatewaysMainMenu")
    private lazy var store = GatewayMenuStatusStore(disconnectProfile: { [weak self] profileID in
        await self?.disconnectIdleProfile(profileID)
    })
    private var windowOpens: [UUID: (target: DashboardGatewayTarget, task: Task<Void, Never>)] = [:]
    private let ownedMenu = NSMenu(title: String(localized: "Gateways"))
    private weak var topLevelItem: NSMenuItem?
    private var installed = false
    private var loggedMissingMenu = false
    private var isMenuOpen = false
    private var refreshTask: Task<Void, Never>?
    private var openingID: UUID?
    private var rows: [(gateway: DashboardGatewayMenuItem, item: NSMenuItem)] = []
    private var rowSignature: [RowSignature]?
    private var profiles: [String: MacGatewayCatalogProfile] = [:]
    private var primaryLabels = GatewayMenuEndpointLabels()

    override init() {
        super.init()
        self.ownedMenu.delegate = self
        self.ownedMenu.autoenablesItems = false
        self.ownedMenu.minimumWidth = StatusMenuMetrics.width
    }

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
        self.topLevelItem = NSApp.mainMenu?.items.first(where: {
            $0.title == String(localized: "Gateways")
        })
        guard let topLevelItem = self.topLevelItem else { return false }
        // SwiftUI owns the top-level item; AppKit owns the view-based submenu.
        if topLevelItem.submenu !== self.ownedMenu {
            topLevelItem.submenu = self.ownedMenu
            self.logger.debug("Attached AppKit Gateways submenu")
        }
        self.rebuildRowsIfNeeded()
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
                if !self.attachSubmenu() {
                    self.reportMissingMenu()
                }
                self.updateCards()
                self.observeGatewayChanges()
            }
        }
    }

    func menuNeedsUpdate(_: NSMenu) {
        self.updateCards()
    }

    private func rebuildRowsIfNeeded() {
        guard !self.isMenuOpen else { return }
        let gateways = DashboardGatewayMenuModel.items(from: DashboardManager.shared.gatewayEntries)
        let signature = gateways.map(RowSignature.init)
        guard signature != self.rowSignature else {
            for (index, gateway) in gateways.enumerated() {
                self.rows[index].gateway = gateway
            }
            return
        }
        let now = Date()
        self.ownedMenu.removeAllItems()
        self.rows.removeAll()
        for gateway in gateways {
            let key = gateway.shortcutNumber.map(String.init) ?? ""
            let item = NSMenuItem(title: gateway.name, action: #selector(self.openGateway(_:)), keyEquivalent: key)
            item.target = self
            item.identifier = NSUserInterfaceItemIdentifier(gateway.id)
            item.keyEquivalentModifierMask = [.command]
            self.configureCard(item, gateway: gateway, now: now)
            self.ownedMenu.addItem(item)
            self.rows.append((gateway, item))

            let alternate = NSMenuItem(
                title: String(format: String(localized: "New %@ Window"), gateway.name),
                action: #selector(self.newGatewayWindow(_:)),
                keyEquivalent: key)
            alternate.target = self
            alternate.identifier = item.identifier
            alternate.isAlternate = true
            alternate.keyEquivalentModifierMask = [.command, .option]
            self.ownedMenu.addItem(alternate)
            if gateway.isPrimary, gateways.contains(where: { !$0.isPrimary }) {
                self.ownedMenu.addItem(.separator())
            }
        }
        if !gateways.isEmpty {
            self.ownedMenu.addItem(.separator())
        }
        let manage = NSMenuItem(
            title: String(localized: "Manage Gateways…"),
            action: #selector(self.manageGateways(_:)),
            keyEquivalent: "")
        manage.target = self
        self.ownedMenu.addItem(manage)
        self.rowSignature = signature
    }

    func menuWillOpen(_: NSMenu) {
        if !self.attachSubmenu() {
            self.reportMissingMenu()
        }
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
        // Probe the rows that exist now; a catalog refresh can take seconds while
        // a profile window is open, and cards must not wait for it.
        self.store.beginProbing(targets: self.rows.map(\.gateway.target)) { [weak self] in
            guard let self, self.openingID == openingID else { return }
            self.updateCards()
        }
        self.updateCards()
        self.refreshTask = Task { [weak self] in
            async let refresh: Void = DashboardManager.shared.refreshGatewaySnapshots()
            let profiles = try? await MacGatewayProfileStore.shared.catalogProfiles()
            guard let self, !Task.isCancelled, self.openingID == openingID else { return }
            if let profiles {
                self.profiles = Dictionary(uniqueKeysWithValues: profiles.map { ($0.profile.id, $0) })
            } else {
                self.logger.debug("Could not load Gateway menu profile metadata")
            }
            self.updateCards()
            await refresh
            guard !Task.isCancelled, self.openingID == openingID else { return }
            self.updateCards()
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        self.isMenuOpen = false
        self.openingID = nil
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.store.endProbing { Self.activeConsumerCount(for: $0) }
        StatusMenuHighlightDelegate.shared.menuDidClose(menu)
    }

    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        StatusMenuHighlightDelegate.shared.menu(menu, willHighlight: item)
    }

    private func updateCards() {
        let now = Date()
        for (gateway, item) in self.rows {
            self.configureCard(item, gateway: gateway, now: now)
        }
    }

    private func configureCard(_ item: NSMenuItem, gateway: DashboardGatewayMenuItem, now: Date) {
        let dashboard = DashboardManager.shared
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
        guard !Task.isCancelled, Self.activeConsumerCount(for: target) == 0 else { return }
        await MacGatewayConnectionFleet.shared.disconnect(profileID: profileID, ifCurrent: { !Task.isCancelled })
    }

    /// Dashboard windows and native chat windows share a saved profile's fleet
    /// connection; probe cleanup may only disconnect when neither is open.
    private static func activeConsumerCount(for target: DashboardGatewayTarget) -> Int {
        var count = DashboardManager.shared.openWindowCount(for: target)
        if case let .profile(profileID) = target {
            count += WebChatManager.shared.openWindowCount(profileID: profileID)
        }
        return count
    }

    @objc private func manageGateways(_: NSMenuItem) {
        AppNavigationActions.openConnection(tab: .gateways)
    }
}
