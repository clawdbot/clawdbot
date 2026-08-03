import Foundation
import OpenClawKit

@MainActor
final class NodeCapabilityRouter {
    enum RouterError: Error {
        case unknownCommand
        case handlerUnavailable
    }

    typealias Handler = @MainActor @Sendable (BridgeInvokeRequest) async throws -> BridgeInvokeResponse

    private let handlers: [String: Handler]

    init(handlers: [String: Handler]) {
        self.handlers = handlers
    }

    func handle(_ request: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        guard let handler = handlers[request.command] else {
            throw RouterError.unknownCommand
        }
        return try await handler(request)
    }
}
