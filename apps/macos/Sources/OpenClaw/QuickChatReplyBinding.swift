import Observation
import OpenClawChatUI

@MainActor
@Observable
final class QuickChatReplyBinding {
    typealias ViewModelFactory = @MainActor (QuickChatRoutingTarget) -> OpenClawChatViewModel

    private(set) var route: QuickChatRoutingTarget?
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var isPastingReply = false
    private(set) var pasteStatusMessage: String?
    @ObservationIgnored private var preparedRoute: QuickChatRoutingTarget?

    @ObservationIgnored private let viewModelFactory: ViewModelFactory

    init(viewModelFactory: @escaping ViewModelFactory = QuickChatReplyBinding.makeViewModel) {
        self.viewModelFactory = viewModelFactory
    }

    /// Starts the transport consumer before the send is dispatched so no early
    /// delta/final frame is missed; the reply area stays hidden until show(route:).
    /// Accepted tradeoff: construction does not synchronously install the transport
    /// subscription (scheduler-scale gap). Deltas carry full snapshots, the shared
    /// view model self-heals from them, and history bootstrap recovers committed
    /// turns — so only a turn completing within a runloop tick could be lost, which
    /// is not a real production state and does not justify a readiness handshake in
    /// the shared chat kit.
    func prepare(route: QuickChatRoutingTarget) {
        guard self.preparedRoute != route || self.viewModel == nil else { return }
        self.preparedRoute = route
        self.viewModel = self.viewModelFactory(route)
    }

    func show(route: QuickChatRoutingTarget) {
        self.prepare(route: route)
        self.route = route
    }

    func rebindIfActive(route: QuickChatRoutingTarget) {
        // Only a VISIBLE reply rebinds; hidden prepared state from a failed send must
        // not be promoted into an expanded transcript by a later target change.
        guard self.route != nil else { return }
        self.show(route: route)
    }

    func clear() {
        self.route = nil
        self.preparedRoute = nil
        self.viewModel = nil
        self.isPastingReply = false
        self.pasteStatusMessage = nil
    }

    func beginPaste() -> Bool {
        guard !self.isPastingReply else { return false }
        self.isPastingReply = true
        self.pasteStatusMessage = nil
        return true
    }

    func finishPaste(message: String? = nil) {
        self.isPastingReply = false
        self.pasteStatusMessage = message
    }

    private static func makeViewModel(route: QuickChatRoutingTarget) -> OpenClawChatViewModel {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: route.agentID)
        return OpenClawChatViewModel(
            sessionKey: route.sessionKey,
            transport: transport,
            activeAgentId: route.agentID)
    }
}
