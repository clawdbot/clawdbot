import Observation
import OpenClawChatUI

@MainActor
@Observable
final class QuickChatReplyBinding {
    typealias ViewModelFactory = @MainActor (QuickChatRoutingIdentity) -> OpenClawChatViewModel

    private(set) var route: QuickChatRoutingTarget?
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var isPastingReply = false
    private(set) var pasteStatusMessage: String?
    @ObservationIgnored private var preparedIdentity: QuickChatRoutingIdentity?

    @ObservationIgnored private let viewModelFactory: ViewModelFactory

    init(viewModelFactory: @escaping ViewModelFactory = QuickChatReplyBinding.makeViewModel) {
        self.viewModelFactory = viewModelFactory
    }

    /// Starts the transport consumer before the send is dispatched so no early
    /// delta/final frame is missed; the reply area stays hidden until show(identity:).
    /// Accepted tradeoff: construction does not synchronously install the transport
    /// subscription (scheduler-scale gap). Deltas carry full snapshots, the shared
    /// view model self-heals from them, and history bootstrap recovers committed
    /// turns — so only a turn completing within a runloop tick could be lost, which
    /// is not a real production state and does not justify a readiness handshake in
    /// the shared chat kit.
    func prepare(identity: QuickChatRoutingIdentity) {
        guard self.preparedIdentity != identity || self.viewModel == nil else { return }
        self.preparedIdentity = identity
        self.viewModel = self.viewModelFactory(identity)
    }

    func show(identity: QuickChatRoutingIdentity) {
        self.prepare(identity: identity)
        self.route = identity.target
    }

    func rebindIfActive(identity: QuickChatRoutingIdentity) {
        // Only a VISIBLE reply rebinds; hidden prepared state from a failed send must
        // not be promoted into an expanded transcript by a later target change.
        guard self.route != nil else { return }
        self.show(identity: identity)
    }

    func clear() {
        self.route = nil
        self.preparedIdentity = nil
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

    static func makeViewModel(identity: QuickChatRoutingIdentity) -> OpenClawChatViewModel {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: identity.target.agentID)
        return OpenClawChatViewModel(
            sessionKey: identity.target.sessionKey,
            transport: transport,
            activeAgentId: identity.target.agentID,
            sessionRoutingContract: identity.sessionRoutingContract)
    }
}
