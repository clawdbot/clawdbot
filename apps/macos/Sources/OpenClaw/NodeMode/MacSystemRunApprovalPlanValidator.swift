import CryptoKit
import Foundation
import OpenClawIPC
import OpenClawKit

enum MacSystemRunApprovalPlanValidator {
    static func matches(
        _ plan: OpenClawSystemRunApprovalPlan,
        params: OpenClawSystemRunParams,
        validatedCommand: ExecHostValidatedRequest) -> Bool
    {
        // Delayed authority is signed for one normalized request. Match the
        // same fields as the Node host before trusting its policy snapshot.
        plan.argv == validatedCommand.command &&
            plan.commandText == validatedCommand.displayCommand &&
            self.normalized(plan.cwd) == self.normalized(params.cwd) &&
            self.normalized(plan.agentId) == self.normalized(params.agentId) &&
            self.normalized(plan.sessionKey) == self.normalized(params.sessionKey)
    }

    static func revalidateMutableFileOperand(
        _ operand: OpenClawSystemRunApprovalFileOperand,
        command: [String],
        cwd: String?) -> Bool
    {
        guard operand.argvIndex >= 0,
              operand.argvIndex < command.count,
              let rawPath = self.normalized(command[operand.argvIndex])
        else { return false }

        let basePath = self.normalized(cwd) ?? FileManager.default.currentDirectoryPath
        let resolvedURL = URL(fileURLWithPath: rawPath, relativeTo: URL(fileURLWithPath: basePath, isDirectory: true))
            .standardizedFileURL
            .resolvingSymlinksInPath()
        guard resolvedURL.path == operand.path,
              let data = try? Data(contentsOf: resolvedURL, options: .mappedIfSafe)
        else { return false }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return digest == operand.sha256
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let scalars = value.unicodeScalars
        var start = scalars.startIndex
        while start != scalars.endIndex, self.isECMAScriptTrimScalar(scalars[start]) {
            start = scalars.index(after: start)
        }
        var end = scalars.endIndex
        while end != start {
            let previous = scalars.index(before: end)
            guard self.isECMAScriptTrimScalar(scalars[previous]) else { break }
            end = previous
        }
        let trimmed = String(scalars[start..<end])
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isECMAScriptTrimScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0009...0x000D,
             0x0020,
             0x00A0,
             0x1680,
             0x2000...0x200A,
             0x2028,
             0x2029,
             0x202F,
             0x205F,
             0x3000,
             0xFEFF:
            true
        default:
            false
        }
    }
}
