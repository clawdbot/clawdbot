import Foundation
import OSLog

enum LaunchdManager {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app.login-agent")
    private static func runLaunchctl(_ args: [String]) {
        let process = Process()
        process.launchPath = "/bin/launchctl"
        process.arguments = args
        try? process.run()
    }

    static func startOpenClaw() {
        guard !AppProfile.current.isActive else {
            self.logger.info("login-agent restart skipped (unavailable under app profile)")
            return
        }
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        self.runLaunchctl(["kickstart", "-k", userTarget])
    }
}
