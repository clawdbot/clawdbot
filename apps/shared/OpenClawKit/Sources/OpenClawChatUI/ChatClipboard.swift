import Foundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Single owner for chat copy-to-clipboard actions so views never touch
/// platform pasteboard APIs directly.
@MainActor
enum ChatClipboard {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}
