process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const { classifyCommand } = await import("../src/usage.js");

await describe("usage command classification", async () => {
  await it("classifies verbose diagnostic commands across common ecosystems as test-build", () => {
    const commands = [
      "dotnet test --configuration Release --no-restore --filter FullyQualifiedName~Example",
      "powershell.exe -NoProfile -Command \"Get-Process App -ErrorAction SilentlyContinue | Stop-Process -Force\"; dotnet publish App/App.csproj -c Release",
      "npm run typecheck",
      "pnpm lint",
      "cargo clippy --all-targets",
      "go test ./...",
      "python -m pytest tests/test_api.py",
      "mvn verify",
      "gradlew build",
      "vite build",
      "next lint",
      "tsc --noEmit",
      "vue-tsc --noEmit",
      "eslint src --max-warnings=0",
      "vitest run",
      "playwright test",
      "cypress run",
      "./gradlew assembleRelease",
      "./gradlew :app:assembleRelease",
      "./gradlew connectedAndroidTest",
      "./gradlew lintDebug",
      "xcodebuild test -scheme App",
      "xcodebuild archive -scheme App",
      "swift test",
      "swiftlint",
      "fastlane beta",
      "make test",
      "cmake --build build",
      "ctest --output-on-failure",
    ];

    for (const command of commands) {
      assert.equal(classifyCommand(command), "test-build", command);
    }
  });

  await it("classifies runtime log commands as infra-logs", () => {
    assert.equal(classifyCommand("adb logcat"), "infra-logs");
    assert.equal(classifyCommand("xcrun simctl spawn booted log stream --style compact"), "infra-logs");
  });

  await it("classifies dependency-oriented commands separately", () => {
    assert.equal(classifyCommand("dotnet restore"), "dependencies");
    assert.equal(classifyCommand("dotnet list package"), "dependencies");
    assert.equal(classifyCommand("npm ci"), "dependencies");
    assert.equal(classifyCommand("cargo tree"), "dependencies");
  });
});
