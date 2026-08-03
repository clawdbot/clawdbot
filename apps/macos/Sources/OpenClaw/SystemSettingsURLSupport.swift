import AppKit
import Foundation

enum SystemSettingsURLSupport {
    static func openFirst(_ candidates: [String]) {
        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}
