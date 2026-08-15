import Testing
@testable import OpenClawMacCLI

struct RootCommandParserTests {
    @Test func `parse root command returns nil for empty args`() {
        #expect(parseRootCommand([]) == nil)
    }

    @Test func `parse root command splits command name and args`() throws {
        let command = try #require(parseRootCommand(["connect", "--json", "--timeout", "3000"]))

        #expect(command.name == "connect")
        #expect(command.args == ["--json", "--timeout", "3000"])
    }

    @Test func `help aliases resolve to usage`() {
        for args in [[], ["-h"], ["--help"], ["help"]] {
            #expect(resolveRootCommandAction(args) == .usage)
        }
    }

    @Test func `known commands preserve trailing args`() {
        #expect(resolveRootCommandAction(["connect", "--json"]) == .connect(["--json"]))
        #expect(
            resolveRootCommandAction(["configure-remote", "--ssh-target", "alice@example.com"])
                == .configureRemote(["--ssh-target", "alice@example.com"]))
        #expect(resolveRootCommandAction(["discover", "--include-local"]) == .discover(["--include-local"]))
        #expect(resolveRootCommandAction(["wizard", "--mode", "local"]) == .wizard(["--mode", "local"]))
    }

    @Test func `unknown command resolves to nonzero exit action`() {
        #expect(resolveRootCommandAction(["nope"]) == .unknown(exitCode: 1))
    }

    @Test func `command names remain case sensitive`() {
        #expect(resolveRootCommandAction(["Connect"]) == .unknown(exitCode: 1))
    }
}
