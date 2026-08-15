import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    /// KeyboardShortcuts owns UserDefaults persistence for the recorded chord.
    static let toggleQuickChat = Self(
        AppProfile.current.name.map { "toggleQuickChat-\($0)" } ?? "toggleQuickChat",
        initial: .init(.space, modifiers: [.option]))
}
