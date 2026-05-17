import AppKit
import Foundation
import OSLog

let dashboardWindowLogger = Logger(subsystem: "ai.openclaw", category: "DashboardWindow")

enum DashboardWindowLayout {
    static let windowSize = NSSize(width: 1240, height: 860)
    static let windowMinSize = NSSize(width: 900, height: 620)
}

struct DashboardWindowAuth: Equatable {
    var gatewayUrl: String?
    var token: String?
    var password: String?

    var hasCredential: Bool {
        self.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ||
            self.password?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}
