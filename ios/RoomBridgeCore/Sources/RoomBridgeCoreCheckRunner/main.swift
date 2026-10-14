import Foundation
import RoomBridgeCoreChecks

let suite = CheckSuite(fixturesDir: CheckSuite.locateFixtures())
do {
    try suite.runAll()
} catch {
    print("FAILED to run checks: \(error)")
    exit(2)
}
for f in suite.failures { print("FAIL \(f)") }
print("RoomBridgeCore checks: \(suite.passed) passed, \(suite.failures.count) failed")
exit(suite.failures.isEmpty ? 0 : 1)
