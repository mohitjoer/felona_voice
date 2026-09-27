import type { FelAgent } from "../agent.js";
import type { InteractResult } from "../types.js";

/**
 * Declarative regression tests for voice agents.
 *
 * A voice agent's behaviour is a function of the *caller*, not of a function
 * signature, so ordinary unit tests cannot cover it. This harness drives an
 * agent through scripted conversations and asserts on what it did — which
 * action JEV chose, what it said, what it collected, how confident it was.
 *
 * That matters most for JEV routing: changing an action description or the
 * embedding provider silently re-routes every agent built on it, and nothing in
 * a type system notices. Scenarios are how that gets caught.
 */

/** Assertions checked against a single turn's result. */
export interface TurnExpectations {
  /** The action JEV must have selected. */
  action?: string;
  /** Substrings the reply must contain. All must match. */
  responseContains?: string | string[];
  /** Pattern the reply must match. */
  responseMatches?: RegExp;
  /** Substrings the reply must NOT contain. */
  responseExcludes?: string | string[];
  /** Confidence bounds for the JEV match, 0-1. */
  confidence?: { above?: number; below?: number };
  /** Slot values that must be present after the turn. */
  slots?: Record<string, unknown>;
  /** Maximum decision latency for the turn. */
  latencyUnderMs?: number;
}

export interface ScenarioTurn {
  /** What the simulated caller says. */
  say: string;
  /** Built-in assertions. */
  expect?: TurnExpectations;
  /**
   * Escape hatch for anything the built-in assertions cannot express.
   * Throwing fails the turn.
   */
  assert?: (result: InteractResult, agent: FelAgent) => void | Promise<void>;
}

export interface Scenario {
  /** Human-readable name, used in failure output. */
  name: string;
  /**
   * Start from a clean session. Default: true, because a scenario that inherits
   * the previous scenario's memory is order-dependent and will flake.
   */
  isolated?: boolean;
  /** Session id to use. Defaults to a per-scenario id. */
  sessionId?: string;
  turns: ScenarioTurn[];
}

/** Outcome of a single asserted turn. */
export interface TurnResult {
  say: string;
  passed: boolean;
  /** Human-readable failures, empty when the turn passed. */
  failures: string[];
  action?: string;
  confidence?: number;
  latencyMs?: number;
  response?: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  turns: TurnResult[];
  durationMs: number;
  /** Set when the scenario could not run at all. */
  error?: string;
}

export interface ScenarioReport {
  total: number;
  passed: number;
  failed: number;
  scenarios: ScenarioResult[];
  durationMs: number;
}

export interface RunScenariosOptions {
  /** Stop on the first failing scenario. Default: false. */
  bail?: boolean;
  /** Print a per-scenario line as it runs. Default: false. */
  verbose?: boolean;
  /** Sink for progress lines. Default: console.log. */
  log?: (message: string) => void;
}

class AssertionFailure extends Error {}

/** Assert a condition, or throw with a readable message. */
function check(condition: boolean, message: string): void {
  if (!condition) throw new AssertionFailure(message);
}

function describe(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Run the built-in expectations for one turn. */
function checkExpectations(
  expectations: TurnExpectations,
  result: InteractResult,
): void {
  if (expectations.action !== undefined) {
    check(
      result.action.id === expectations.action,
      `expected action "${expectations.action}" but got "${result.action.id}"`,
    );
  }

  if (expectations.responseContains !== undefined) {
    const needles =
      typeof expectations.responseContains === "string"
        ? [expectations.responseContains]
        : expectations.responseContains;
    for (const needle of needles) {
      check(
        result.text.toLowerCase().includes(needle.toLowerCase()),
        `response did not contain "${needle}" (got: ${describe(result.text)})`,
      );
    }
  }

  if (expectations.responseMatches !== undefined) {
    check(
      expectations.responseMatches.test(result.text),
      `response did not match ${expectations.responseMatches} (got: ${describe(result.text)})`,
    );
  }

  if (expectations.responseExcludes !== undefined) {
    const excludes: string[] =
      typeof expectations.responseExcludes === "string"
        ? [expectations.responseExcludes]
        : expectations.responseExcludes;
    for (const needle of excludes) {
      check(
        !result.text.toLowerCase().includes(needle.toLowerCase()),
        `response unexpectedly contained "${needle}"`,
      );
    }
  }

  if (expectations.confidence) {
    const { above, below } = expectations.confidence;
    if (above !== undefined) {
      check(
        result.confidence >= above,
        `confidence ${result.confidence} was below the expected minimum ${above}`,
      );
    }
    if (below !== undefined) {
      check(
        result.confidence <= below,
        `confidence ${result.confidence} was above the expected maximum ${below}`,
      );
    }
  }

  if (expectations.slots) {
    for (const [key, expected] of Object.entries(expectations.slots)) {
      check(
        result.slots[key] === expected,
        `expected slot "${key}" to be ${describe(expected)} but got ${describe(result.slots[key])}`,
      );
    }
  }

  if (expectations.latencyUnderMs !== undefined) {
    check(
      result.telemetry.latencyMs < expectations.latencyUnderMs,
      `decision took ${result.telemetry.latencyMs}ms, over the ${expectations.latencyUnderMs}ms budget`,
    );
  }
}

/** Run one scenario against an agent. */
export async function runScenario(
  agent: FelAgent,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const result: ScenarioResult = {
    name: scenario.name,
    passed: true,
    turns: [],
    durationMs: 0,
  };

  if (!scenario.turns || scenario.turns.length === 0) {
    return {
      ...result,
      passed: false,
      error: "scenario has no turns",
      durationMs: Date.now() - startedAt,
    };
  }

  const sessionId = scenario.sessionId ?? `scenario:${scenario.name}`;

  if (scenario.isolated !== false) {
    // A fresh session per scenario: shared memory makes results order-dependent.
    agent.endSession(sessionId);
  }

  for (const turn of scenario.turns) {
    const turnResult: TurnResult = { say: turn.say, passed: true, failures: [] };

    try {
      const reply = await agent.interact({ userMessage: turn.say, sessionId });

      turnResult.action = reply.action.id;
      turnResult.confidence = reply.confidence;
      turnResult.latencyMs = reply.telemetry.latencyMs;
      turnResult.response = reply.text;

      if (turn.expect) {
        checkExpectations(turn.expect, reply);
      }
      if (turn.assert) {
        await turn.assert(reply, agent);
      }
    } catch (error) {
      const message =
        error instanceof AssertionFailure
          ? error.message
          : `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
      turnResult.failures.push(message);
      turnResult.passed = false;
    }

    result.turns.push(turnResult);
    if (!turnResult.passed) result.passed = false;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Run a suite of scenarios and report.
 *
 * Never throws for a failing scenario — a regression is a result, not an
 * exception, so a whole suite runs and reports every break at once.
 */
export async function runScenarios(
  agent: FelAgent,
  scenarios: Scenario[],
  options?: RunScenariosOptions,
): Promise<ScenarioReport> {
  const startedAt = Date.now();
  const log = options?.log ?? ((message: string) => console.log(message));
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const result = await runScenario(agent, scenario);
    results.push(result);

    if (options?.verbose) {
      const status = result.passed ? "PASS" : "FAIL";
      log(`  ${status}  ${result.name} (${result.durationMs}ms)`);
      for (const turn of result.turns) {
        if (!turn.passed) {
          log(`        turn: "${turn.say}"`);
          for (const failure of turn.failures) log(`        - ${failure}`);
        }
      }
    }

    if (!result.passed && options?.bail) break;
  }

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    scenarios: results,
    durationMs: Date.now() - startedAt,
  };
}

/** Render a report as human-readable text, for CI logs. */
export function formatScenarioReport(report: ScenarioReport): string {
  const lines: string[] = [];
  const icon = report.failed === 0 ? "✅" : "❌";

  lines.push("");
  lines.push(`${icon} Scenarios: ${report.passed}/${report.total} passed in ${report.durationMs}ms`);
  lines.push("");

  for (const scenario of report.scenarios) {
    if (scenario.passed) {
      lines.push(`  ✓ ${scenario.name}`);
      continue;
    }
    lines.push(`  ✗ ${scenario.name}`);
    if (scenario.error) lines.push(`      ${scenario.error}`);
    for (const turn of scenario.turns) {
      if (turn.passed) continue;
      lines.push(`      "${turn.say}"`);
      for (const failure of turn.failures) lines.push(`        ${failure}`);
    }
  }

  return lines.join("\n");
}
