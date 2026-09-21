#!/usr/bin/env node

/**
 * Felona CLI — scaffold, visualize, run, and train voice agents.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  visualizeGraph,
  createSupportAgent,
  VoiceGraph,
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

    case "help":
    case "--help":
    case "-h":
    default: {
      printHelp();
      break;
    }
  }
}

async function handleVisualize(cmdArgs: string[]) {
  let filePath: string | undefined;
  let format: "ascii" | "markdown" | "md" | "html" | "mermaid" | "url" = "ascii";
  let open = false;
  let outputPath: string | undefined;

  for (let i = 0; i < cmdArgs.length; i++) {
    const arg = cmdArgs[i];
    if (arg === "--format" && cmdArgs[i + 1]) {
      format = cmdArgs[++i] as any;
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

  let targetGraph: any;

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
    } catch (err: any) {
      console.error(`❌ Failed to load agent file ${filePath}:`, err.message);
      process.exit(1);
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch {}
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

OPTIONS FOR visualize:
  [file]                     Path to TS/JS file exporting agent or graph
  --md, --markdown           Generate Markdown file with Mermaid diagram and table
  --open, -o                 Open interactive HTML visualizer in default browser
  --format <type>            Output format: ascii (default), markdown, html, mermaid, url
  --mermaid, -m              Output Mermaid flowchart syntax
  --url, -u                  Output Mermaid Live Editor URL
  --out <file.md|file.html>  Save Markdown or HTML visualization to specific path

EXAMPLES:
  felona visualize --md
  felona visualize my-agent.ts --out graph.md
  felona visualize my-agent.ts --open
  felona visualize agent.js --mermaid
  felona visualize agent.js --format markdown
`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
