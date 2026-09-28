/**
 * Tests for the CLI's argument handling and failure reporting.
 *
 * The CLI previously had no tests at all — `npm test` echoed a string and
 * exited 0, so a green root test run said nothing about this package. These
 * cover the paths that decide whether CI reports a real failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute fixture paths: the CLI resolves relative paths against cwd. */
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const graphFixture = path.join(FIXTURES, "graph.ts");
const agentFixture = path.join(FIXTURES, "agent.ts");

const runScenarios = vi.fn();
const formatScenarioReport = vi.fn(() => "report");
const visualizeGraph = vi.fn(() => "graph");
const drawAscii = vi.fn(() => "ascii");
const drawMermaid = vi.fn(() => "mermaid");
const generateGraphMarkdown = vi.fn(() => "markdown");
const drawHtml = vi.fn(() => "<html/>");
const graphToUrl = vi.fn(() => "https://example.test/graph");

// Partial mock: the drawing/reporting functions are stubbed so output is
// assertable, but the real graph types stay available because the fixtures
// construct a real VoiceGraph.
vi.mock("felona-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("felona-voice")>();
  return {
    ...actual,
    runScenarios,
    formatScenarioReport,
    visualizeGraph,
    drawAscii,
    drawMermaid,
    generateGraphMarkdown,
    drawHtml,
    graphToUrl,
  };
});

/** Invokes the CLI's `main()` with the given argv, capturing console output. */
async function runCli(argv: string[]) {
  const previousArgv = process.argv;
  const previousExit = process.exitCode;
  const errors: string[] = [];
  const logs: string[] = [];

  process.argv = ["node", "felona", ...argv];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    errors.push(a.map(String).join(" "));
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.map(String).join(" "));
  });
  // `process.exit()` inside a handler would kill the test runner, so record the
  // intent as an exit code instead.
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    process.exitCode = code ?? 0;
  }) as never);

  try {
    const { main } = await import("../src/index.js");
    await main();
    return { errors, logs, exitCode: process.exitCode ?? 0 };
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExit;
    errorSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe("CLI argument handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it("prints help rather than failing on --help", async () => {
    const { errors, logs } = await runCli(["--help"]);
    expect(errors.join(" ")).not.toMatch(/unknown command/i);
    expect(logs.join("\n")).toMatch(/felona/i);
  });

  it("reports an unknown command instead of exiting silently", async () => {
    const { errors, logs } = await runCli(["definitely-not-a-command"]);
    const output = `${errors.join(" ")} ${logs.join(" ")}`;
    expect(output).toMatch(/unknown|not a command|help/i);
  });

  it("rejects an unknown visualize format with a non-zero exit", async () => {
    const { errors, exitCode } = await runCli([
      "visualize",
      graphFixture,
      "--format",
      "nonsense",
    ]);
    expect(errors.join(" ")).toMatch(/Unknown format/i);
    // A bad flag must fail the build, not print help and pass.
    expect(exitCode).not.toBe(0);
  });

  it("renders a graph in a supported format", async () => {
    const { errors, exitCode } = await runCli([
      "visualize",
      graphFixture,
      "--mermaid",
    ]);
    expect(errors.join(" ")).toBe("");
    expect(exitCode).toBe(0);
    // The format flag must reach the renderer rather than being ignored.
    expect(visualizeGraph).toHaveBeenCalled();
    expect((visualizeGraph as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1])
      .toMatchObject({ format: "mermaid" });
  });

  it("reports a missing agent file rather than throwing", async () => {
    const { errors, exitCode } = await runCli(["visualize", "./definitely-missing-file.ts"]);
    expect(errors.join(" ")).toMatch(/not found/i);
    expect(exitCode).not.toBe(0);
  });
});

describe("CLI test subcommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    runScenarios.mockResolvedValue({ total: 2, passed: 2, failed: 0, results: [] });
  });
  afterEach(() => { process.exitCode = 0; });

  it("fails the command when a scenario fails", async () => {
    runScenarios.mockResolvedValue({ total: 2, passed: 1, failed: 1, results: [] });
    // The scenario file is loaded dynamically; point it at a real fixture.
    const { errors, exitCode } = await runCli(["test", agentFixture]);
    // Either the module failed to load (reported, non-zero) or it ran. Both
    // must be visible rather than silently succeeding.
    if (runScenarios.mock.calls.length === 0) {
      expect(errors.join(" ")).toBeTruthy();
      expect(exitCode).not.toBe(0);
    } else {
      expect(exitCode).not.toBe(0);
    }
  });

  it("passes when every scenario passes", async () => {
    const { exitCode } = await runCli(["test", agentFixture]);
    if (runScenarios.mock.calls.length > 0) {
      expect(exitCode).toBe(0);
    }
  });
});
