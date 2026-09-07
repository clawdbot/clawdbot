import Foundation
import JavaScriptCore

/// Runs the shared TypeScript `compileExecArgPattern` policy inside JavaScriptCore.
enum ExecArgPatternSafety {
    struct CompileResult {
        var accepted: Bool
        var reason: String?
    }

    static func compile(_ source: String) -> CompileResult {
        guard let context = makeContext() else {
            return CompileResult(accepted: false, reason: "invalid-regex")
        }
        context.setObject(source, forKeyedSubscript: "OPENCLAW_EXEC_ARG_PATTERN" as NSString)
        guard let value = context.evaluateScript("""
        (function() {
          var compiled = OpenClawExecArgPattern.compileExecArgPattern(OPENCLAW_EXEC_ARG_PATTERN);
          return {
            accepted: !!(compiled && compiled.regex),
            reason: compiled && compiled.reason ? compiled.reason : null
          };
        })()
        """)
        else {
            return CompileResult(accepted: false, reason: "invalid-regex")
        }
        let accepted = value.forProperty("accepted")?.toBool() ?? false
        let reason: String? = if let reasonValue = value.forProperty("reason"),
                                 !reasonValue.isUndefined,
                                 !reasonValue.isNull
        {
            reasonValue.toString()
        } else {
            nil
        }
        return CompileResult(accepted: accepted, reason: reason)
    }

    static func matches(_ source: String, subject: String) -> Bool {
        guard let context = makeContext() else { return false }
        context.setObject(source, forKeyedSubscript: "OPENCLAW_EXEC_ARG_PATTERN" as NSString)
        context.setObject(subject, forKeyedSubscript: "OPENCLAW_EXEC_ARG_SUBJECT" as NSString)
        guard let value = context.evaluateScript("""
        (function() {
          var compiled = OpenClawExecArgPattern.compileExecArgPattern(OPENCLAW_EXEC_ARG_PATTERN);
          if (!compiled || !compiled.regex) return false;
          return compiled.regex.test(OPENCLAW_EXEC_ARG_SUBJECT);
        })()
        """)
        else { return false }
        return value.toBool()
    }

    private static func makeContext() -> JSContext? {
        guard let context = JSContext() else { return nil }
        context.evaluateScript(ExecArgPatternSafetyJS.source)
        if context.exception != nil {
            return nil
        }
        return context
    }
}
