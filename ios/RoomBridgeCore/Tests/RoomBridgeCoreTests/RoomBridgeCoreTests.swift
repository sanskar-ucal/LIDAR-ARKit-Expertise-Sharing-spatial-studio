import RoomBridgeCoreChecks
import XCTest

/// Runs the same fixture checks as `swift run rbcore-checks`, for use inside Xcode.
final class RoomBridgeCoreTests: XCTestCase {
    func testSharedFixtureChecks() throws {
        let suite = CheckSuite(fixturesDir: CheckSuite.locateFixtures())
        try suite.runAll()
        XCTAssertEqual(suite.failures, [], suite.failures.joined(separator: "\n"))
        XCTAssertGreaterThan(suite.passed, 30)
    }
}
