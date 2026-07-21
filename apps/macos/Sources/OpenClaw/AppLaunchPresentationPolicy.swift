import Foundation

struct AppLaunchPresentationPolicy: Equatable {
    let backgroundOnly: Bool

    init(arguments: [String]) {
        self.backgroundOnly = arguments.contains("--background-only")
    }

    static var current: Self {
        Self(arguments: CommandLine.arguments)
    }

    var allowsAutomaticPresentation: Bool {
        !self.backgroundOnly
    }

    func shouldAutoOpenChat(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation &&
            (arguments.contains("--chat") || arguments.contains("--webchat"))
    }

    func shouldAutoOpenDashboard(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation && arguments.contains("--dashboard")
    }
}
