import Foundation

struct EmptyParams: Encodable {}

enum IPadSidebarGatewayError: Error {
    case offline
    case invalidPayload

    var message: String {
        switch self {
        case .offline:
            "Gateway offline."
        case .invalidPayload:
            "Could not encode request."
        }
    }
}
