#if DEBUG
import AppKit
import Foundation

extension CanvasWindowController {
    static func _testSanitizeSessionKey(_ key: String) -> String {
        self.sanitizeSessionKey(key)
    }

    static func _testJSStringLiteral(_ value: String) -> String {
        self.jsStringLiteral(value)
    }

    static func _testJSOptionalStringLiteral(_ value: String?) -> String {
        self.jsOptionalStringLiteral(value)
    }

    static func _testStoredFrameKey(sessionKey: String) -> String {
        self.storedFrameDefaultsKey(sessionKey: sessionKey)
    }

    static func _testStoreAndLoadFrame(sessionKey: String, frame: NSRect) -> NSRect? {
        self.storeRestoredFrame(frame, sessionKey: sessionKey)
        return self.loadRestoredFrame(sessionKey: sessionKey)
    }

    static func _testParseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes: [UInt8] = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return nil }
        return (bytes[0], bytes[1], bytes[2], bytes[3])
    }

    static func _testIsLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (a, b, _, _) = ip
        if a == 10 { return true }
        if a == 172, (16...31).contains(Int(b)) { return true }
        if a == 192, b == 168 { return true }
        if a == 127 { return true }
        if a == 169, b == 254 { return true }
        if a == 100, (64...127).contains(Int(b)) { return true }
        return false
    }

    static func _testIsLocalNetworkCanvasURL(_ url: URL) -> Bool {
        CanvasA2UIActionMessageHandler.isLocalNetworkCanvasURL(url)
    }
}
#endif
