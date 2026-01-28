import AppKit
import Foundation

enum SoundEffectCatalog {
    /// All discoverable system sound names, with "Glass" pinned first.
    static var systemOptions: [String] {
        var names = Set(Self.discoveredSoundMap.keys).union(Self.fallbackNames)
        names.remove("Glass")
        let sorted = names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        return ["Glass"] + sorted
    }

    static func displayName(for raw: String) -> String { raw }

    static func url(for name: String) -> URL? {
        self.discoveredSoundMap[name]
    }

    // MARK: - Internals

    private static let allowedExtensions: Set<String> = [
        "aif", "aiff", "caf", "wav", "m4a", "mp3",
    ]

    private static let fallbackNames: [String] = [
        "Glass", // default
        "Ping",
        "Pop",
        "Frog",
        "Submarine",
        "Funk",
        "Tink",
        "Basso",
        "Blow",
        "Bottle",
        "Hero",
        "Morse",
        "Purr",
        "Sosumi",
        "Mail Sent",
        "New Mail",
        "Mail Scheduled",
        "Mail Fetch Error",
    ]

    private static let searchRoots: [URL] = [
        FileManager().homeDirectoryForCurrentUser.appendingPathComponent("Library/Sounds"),
        URL(fileURLWithPath: "/Library/Sounds"),
        URL(fileURLWithPath: "/System/Applications/Mail.app/Contents/Resources"), // Mail “swoosh”
        URL(fileURLWithPath: "/System/Library/Sounds"),
    ]

    private static let discoveredSoundMap: [String: URL] = {
        var map: [String: URL] = [:]
        for root in Self.searchRoots {
            guard let contents = try? FileManager().contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles])
            else { continue }

            for url in contents where Self.allowedExtensions.contains(url.pathExtension.lowercased()) {
                let name = url.deletingPathExtension().lastPathComponent
                // Preserve the first match in priority order.
                if map[name] == nil {
                    map[name] = url
                }
            }
        }
        return map
    }()
}

@MainActor
enum SoundEffectPlayer {
    private static var lastSound: NSSound?

    static func sound(named name: String) -> NSSound? {
        if let named = NSSound(named: NSSound.Name(name)) {
            return named
        }
        if let url = SoundEffectCatalog.url(for: name) {
            return NSSound(contentsOf: url, byReference: false)
        }
        return nil
    }

    static func sound(from bookmark: Data) -> NSSound? {
        var stale = false
        guard let url = try? URL(
            resolvingBookmarkData: bookmark,
            options: [.withoutUI, .withSecurityScope],
            bookmarkDataIsStale: &stale)
        else { return nil }

        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return NSSound(contentsOf: url, byReference: false)
    }

    static func play(_ sound: NSSound?) {
        guard let sound else { return }
        self.lastSound = sound
        sound.stop()
        sound.play()
    }
}
