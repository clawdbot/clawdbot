import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    /// KeyboardShortcuts owns UserDefaults persistence for the recorded chord.
    static let toggleQuickChat = Self(
        "toggleQuickChat",
        initial: .init(.space, modifiers: [.option]))
}
