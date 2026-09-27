#!/usr/bin/env node

/**
 * Felona CLI — scaffold, visualize, run, and train voice agents.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  visualizeGraph,
  runScenarios,
  formatScenarioReport,
  VoiceGraph,
  type Scenario,
} from "felona-voice";

const args = process.argv.slice(2);
const command = args[0] || "help";

async function main() {
  switch (command) {
    case "visualize":
    case "graph":
    case "viz": {
      await handleVisualize(args.slice(1));
      break;
    }

    case "test":
    case "scenarios": {
      const passed = await handleTest(args.slice(1));
      if (!passed) process.exit(1);
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default: {
      printHelp();
      break;
    }
  }
}

/**
 * Load a module and resolve the agent and scenarios from it.
 *
 * Accepts either a default export or named `agent` / `scenarios` exports, which
 * covers both a single file and a colocated test module.
 */
async function loadTestModule(filePath: string): Promise<{
  agent: unknown;
  scenarios: Scenario[];
}> {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  let fileToImport = resolved;
  let tmpFile: string | undefined;

  try {
    if (resolved.endsWith(".ts")) {
      try {
        const ts = await import("typescript");
        const source = fs.readFileSync(resolved, "utf-8");
        const transpiled = (ts.default || ts).transpileModule(source, {
          compilerOptions: {
            module: (ts.default || ts).ModuleKind.ESNext,
            target: (ts.default || ts).ScriptTarget.ES2022,
          },
        });
        tmpFile = path.resolve(process.cwd(), `.felona-test-${Date.now()}.mjs`);
        fs.writeFileSync(tmpFile, transpiled.outputText, "utf-8");
        fileToImport = tmpFile;
      } catch {
        fileToImport = resolved;
      }
    }

    const mod = await import(pathToFileURL(fileToImport).href);

    const agent = mod.default ?? mod.agent;
    const scenarios = (mod.scenarios ?? mod.defaultScenarios) as Scenario[] | undefined;

    if (!agent) {
      throw new Error(
        `${filePath} must export an agent (default export or \`export const agent\`).`,
      );
    }
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      throw new Error(`${filePath} must export a non-empty \`scenarios\` array.`);
    }

    return { agent, scenarios };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${filePath}: ${message}`);
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Best-effort cleanup of the temp transpile artifact.
      }
    }
  }
}

async function handleTest(cmdArgs: string[]): Promise<boolean> {
  let filePath: string | undefined;
  let verbose = false;

  for (const arg of cmdArgs) {
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (!arg.startsWith("-")) {
      filePath = arg;
    }
  }

  const target = filePath ?? "./scenarios.ts";

  let agent: unknown;
  let scenarios: Scenario[];
  try {
    ({ agent, scenarios } = await loadTestModule(target));
  } catch (err: unknown) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  console.log(`\n🎙️  Running ${scenarios.length} scenario(s) from ${target}\n`);

  const report = await runScenarios(agent as never, scenarios, { verbose, bail: false });

  console.log(formatScenarioReport(report));
  return report.failed === 0;
}


const VISUALIZE_FORMATS = [
  "ascii",
  "markdown",
  "md",
  "html",
  "mermaid",
  "url",
] as const;

type VisualizeFormat = (typeof VISUALIZE_FORMATS)[number];

function isVisualizeFormat(value: string): value is VisualizeFormat {
  return (VISUALIZE_FORMATS as readonly string[]).includes(value);
}

async function handleVisualize(cmdArgs: string[]) {
  let filePath: string | undefined;
  let format: VisualizeFormat = "ascii";
  let open = false;
  let outputPath: string | undefined;

  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if (arg === "--format" && cmdArgs[i + 1]) {
      const requested = cmdArgs[++i];
      if (!isVisualizeFormat(requested)) {
        console.error(
          `❌ Unknown format "${requested}". Expected one of: ${VISUALIZE_FORMATS.join(", ")}`,
        );
        process.exit(1);
      }
      format = requested;
    } else if (arg === "--open" || arg === "-o") {
      open = true;
      format = "html";
    } else if (arg === "--md" || arg === "--markdown") {
      format = "markdown";
      if (!outputPath && !cmdArgs.includes("--out")) {
        outputPath = path.resolve(process.cwd(), "agent-graph.md");
      }
    } else if (arg === "--mermaid" || arg === "-m") {
      format = "mermaid";
    } else if (arg === "--url" || arg === "-u") {
      format = "url";
    } else if (arg === "--out" && cmdArgs[i + 1]) {
      outputPath = cmdArgs[++i];
      if (outputPath.endsWith(".md")) {
        format = "markdown";
      } else if (outputPath.endsWith(".html")) {
        format = "html";
      }
    } else if (!arg.startsWith("-")) {
      filePath = arg;
    }
  }

  let targetGraph: unknown;

  if (filePath) {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`❌ File not found: ${resolvedPath}`);
      process.exit(1);
    }

    let fileToImport = resolvedPath;
    let tmpFile: string | undefined;

    try {
      if (resolvedPath.endsWith(".ts")) {
        try {
          const ts = await import("typescript");
          const source = fs.readFileSync(resolvedPath, "utf-8");
          const transpiled = (ts.default || ts).transpileModule(source, {
            compilerOptions: {
              module: (ts.default || ts).ModuleKind.ESNext,
              target: (ts.default || ts).ScriptTarget.ES2022,
            },
          });
          tmpFile = path.resolve(process.cwd(), `.felona-viz-${Date.now()}.mjs`);
          fs.writeFileSync(tmpFile, transpiled.outputText, "utf-8");
          fileToImport = tmpFile;
        } catch {
          // If typescript module isn't resolvable, fallback to direct import
          fileToImport = resolvedPath;
        }
      }

      const fileUrl = pathToFileURL(fileToImport).href;
      const mod = await import(fileUrl);
      targetGraph = mod.default || mod.agent || mod.graph || mod.workflow || mod;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`❌ Failed to load agent file ${filePath}:`, reason);
      process.exit(1);
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Best-effort cleanup of the temp transpile artifact.
      }
      }
    }
  } else {
    // Default example: Create sample customer support voice graph
    console.log("ℹ️  No agent file specified. Rendering default Customer Support VoiceGraph:\n");
    const sample = new VoiceGraph()
      .addNode("greet", {
        description: "Warm greeting to caller and identify intent",
        run: "Hello! Thank you for calling Acme. How can I help you today?",
      })
      .addNode("order_status", {
        description: "Check delivery status, tracking number, and carrier ETA",
        run: "Your package is on track for delivery today before 5 PM.",
      })
      .addNode("refund_request", {
        description: "Handle customer refund, return label, and policy verification",
        run: "I have initiated your refund request. You will receive an email shortly.",
      })
      .addNode("transfer_human", {
        description: "Escalate to a human tier-2 support agent",
        run: "Transferring you to a live specialist right now. Please hold.",
      })
      .addNode("fallback", {
        description: "Unrecognized queries, background noise, or off-topic questions",
        run: "Sorry, I am not able to understand. How can I assist with your order?",
      })
      .addEdge("greet", "order_status")
      .addEdge("greet", "refund_request")
      .addEdge("greet", "transfer_human")
      .addEdge("order_status", "transfer_human")
      .addEdge("refund_request", "transfer_human")
      .setEntryPoint("greet");

    targetGraph = sample;
  }

  await visualizeGraph(targetGraph, {
    format,
    open,
    outputPath,
    print: true,
  });
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║               🎙️  Felona Voice CLI                            ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  felona <command> [options]

COMMANDS:
  visualize, graph, viz      Visualize an agent or VoiceGraph
                             • Generate Markdown (.md) documentation
                             • Render ASCII flowchart in terminal
                             • Generate Mermaid markdown
                             • Launch interactive HTML visualizer
  test, scenarios            Run an agent's regression scenarios and exit
                             non-zero on failure (for CI)

OPTIONS FOR visualize:
  [file]                     Path to TS/JS file exporting agent or graph
  --md, --markdown           Generate Markdown file with Mermaid diagram and table
  --open, -o                 Open interactive HTML visualizer in default browser
  --format <type>            Output format: ascii (default), markdown, html, mermaid, url
  --mermaid, -m              Output Mermaid flowchart syntax
  --url, -u                  Output Mermaid Live Editor URL
  --out <file.md|file.html>  Save Markdown or HTML visualization to specific path

OPTIONS FOR test:
  [file]                     Path to a TS/JS file exporting \`agent\` and \`scenarios\`
                             (default: ./scenarios.ts)
  --verbose, -v              Print a line per scenario as it runs

EXAMPLES:
  felona visualize --md
  felona visualize my-agent.ts --out graph.md
  felona visualize my-agent.ts --open
  felona visualize agent.js --mermaid
  felona test ./scenarios.ts
  felona test ./e2e/support.scenarios.ts --verbose
`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
