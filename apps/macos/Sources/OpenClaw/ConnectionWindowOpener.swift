import Observation

enum ConnectionTab: CaseIterable, Hashable {
    case connection
    case gateways
    case debug

    static func available(debugEnabled: Bool) -> [Self] {
        debugEnabled ? [.connection, .gateways, .debug] : [.connection, .gateways]
    }
}

@MainActor
@Observable
final class ConnectionWindowOpener {
    static let shared = ConnectionWindowOpener()

    var selectedTab: ConnectionTab = .connection
    private var openWindowAction: (@MainActor () -> Void)?

    func register(openWindow: @escaping @MainActor () -> Void) {
        self.openWindowAction = openWindow
    }

    func open(tab: ConnectionTab = .connection, debugEnabled: Bool) {
        guard ConnectionTab.available(debugEnabled: debugEnabled).contains(tab) else { return }
        self.selectedTab = tab
        self.openWindowAction?()
    }
}
