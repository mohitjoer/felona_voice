import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";

export interface GraphData {
  name?: string;
  nodes: Array<{
    id: string;
    description: string;
    metadata?: Record<string, unknown>;
  }>;
  edges: Array<{ from: string; to: string }>;
  entryPoint?: string;
}

export interface VisualizeOptions {
  /** Output format: "ascii" (terminal text), "markdown" | "md" (markdown file with Mermaid & tables), "html" (interactive visualizer), "mermaid" (flowchart code), or "url" (Mermaid Live URL) */
  format?: "ascii" | "markdown" | "md" | "html" | "mermaid" | "url";
  /** If true, automatically opens the visualizer in your default web browser (HTML) or editor */
  open?: boolean;
  /** Custom title or agent name for the visualization */
  title?: string;
  /** File path to save the generated visualization (e.g. ./agent-graph.md or ./agent-graph.html) */
  outputPath?: string;
  /** If true (default for ascii), logs the result to console.log */
  print?: boolean;
}

export interface VisualizeResult {
  ascii: string;
  mermaid: string;
  markdown: string;
  url: string;
  html: string;
  filePath?: string;
}

/**
 * Normalize any Felona entity (VoiceGraph, CompiledVoiceGraph, FelAgent, or raw GraphData) into GraphData.
 */
export function extractGraphData(target: unknown): GraphData {
  if (!target || typeof target !== "object") {
    throw new Error("Invalid graph target: expected VoiceGraph, CompiledVoiceGraph, FelAgent, or GraphData");
  }

  const obj = target as Record<string, any>;

  // If object has .getGraph() method (VoiceGraph or CompiledVoiceGraph)
  if (typeof obj.getGraph === "function") {
    const data = obj.getGraph() as GraphData;
    return {
      name: data.name || (obj.name as string) || "Voice Graph",
      nodes: data.nodes || [],
      edges: data.edges || [],
      entryPoint: data.entryPoint || (data.nodes.length > 0 ? data.nodes[0].id : undefined),
    };
  }

  // If object is a FelAgent (has actions array and name)
  if (Array.isArray(obj.actions)) {
    const actions = obj.actions as Array<{ id: string; description: string }>;
    const nodes = actions.map((a) => ({
      id: a.id,
      description: a.description || "",
    }));
    return {
      name: (obj.name as string) || "FelAgent Action Space",
      nodes,
      edges: [],
      entryPoint: nodes.length > 0 ? nodes[0].id : undefined,
    };
  }

  // If raw GraphData with nodes array
  if (Array.isArray(obj.nodes)) {
    return {
      name: (obj.name as string) || "Voice Graph",
      nodes: obj.nodes,
      edges: Array.isArray(obj.edges) ? obj.edges : [],
      entryPoint: (obj.entryPoint as string) || (obj.nodes.length > 0 ? obj.nodes[0].id : undefined),
    };
  }

  throw new Error("Unable to extract graph data from provided object. Ensure it is a VoiceGraph, CompiledVoiceGraph, FelAgent, or GraphData.");
}

/**
 * Render a beautiful Unicode/ASCII directed graph in the terminal.
 * Inspired by LangGraph draw_ascii().
 */
export function drawAscii(target: unknown, options?: { title?: string }): string {
  const data = extractGraphData(target);
  const title = options?.title || data.name || "Felona Voice Graph";
  const lines: string[] = [];

  const width = 64;
  const headerText = `🎙️  ${title} (${data.nodes.length} nodes, ${data.edges.length} explicit edges)`;
  const padLen = Math.max(0, width - 4 - headerText.length);

  lines.push("┌" + "─".repeat(width - 2) + "┐");
  lines.push(`│ ${headerText}${" ".repeat(padLen)} │`);
  lines.push("└" + "─".repeat(width - 2) + "┘");
  lines.push("");

  const entry = data.entryPoint || (data.nodes.length > 0 ? data.nodes[0].id : "start");
  const nodesMap = new Map(data.nodes.map((n) => [n.id, n]));

  // 1. Render Starting Flow
  lines.push("  ● [START]");
  lines.push("    │");
  lines.push("    ▼");

  // Format entry node
  const entryNode = nodesMap.get(entry);
  const entryDesc = entryNode?.description ? `"${entryNode.description.slice(0, 48)}"` : "";
  lines.push("  ┌────────────────────────────────────────────────────────┐");
  lines.push(`  │ 🟢 ${entry.padEnd(24)} (Entry Point)           │`);
  if (entryDesc) {
    lines.push(`  │    ${entryDesc.padEnd(52)}│`);
  }
  lines.push("  └────────────────────────────────────────────────────────┘");

  // Outgoing edges from entry or all nodes if no explicit edges
  const outgoingFromEntry = data.edges.filter((e) => e.from === entry).map((e) => e.to);
  const otherNodes = data.nodes.filter((n) => n.id !== entry);

  if (outgoingFromEntry.length > 0) {
    lines.push("    │");
    outgoingFromEntry.forEach((targetId, idx) => {
      const isLast = idx === outgoingFromEntry.length - 1;
      const branch = isLast ? "    └──► " : "    ├──► ";
      const tNode = nodesMap.get(targetId);
      const desc = tNode?.description ? ` — "${tNode.description.slice(0, 36)}"` : "";
      lines.push(`${branch}[${targetId}]${desc}`);
    });
  } else if (otherNodes.length > 0) {
    // Dynamic JEV semantic routing (all nodes accessible)
    lines.push("    │  (JEV Semantic Action Space: Dynamic Cosine Routing)");
    otherNodes.forEach((node, idx) => {
      const isLast = idx === otherNodes.length - 1;
      const branch = isLast ? "    └──► " : "    ├──► ";
      const tag = node.id === "fallback" ? " [FALLBACK]" : "";
      const desc = node.description ? ` — "${node.description.slice(0, 36)}"` : "";
      lines.push(`${branch}[${node.id}]${tag}${desc}`);
    });
  }

  // 2. Adjacency Table if explicit edges exist
  if (data.edges.length > 0) {
    lines.push("");
    lines.push("── Directed Transitions ─────────────────────────────────");
    const edgeMap = new Map<string, string[]>();
    for (const edge of data.edges) {
      if (!edgeMap.has(edge.from)) edgeMap.set(edge.from, []);
      edgeMap.get(edge.from)!.push(edge.to);
    }

    for (const [from, toList] of edgeMap.entries()) {
      lines.push(`  ${from.padEnd(16)} ──► ${toList.join(", ")}`);
    }

    // List any isolated / root nodes
    const destinations = new Set(data.edges.map((e) => e.to));
    const sources = new Set(data.edges.map((e) => e.from));
    const unlinked = data.nodes.filter((n) => !destinations.has(n.id) && !sources.has(n.id) && n.id !== entry);
    if (unlinked.length > 0) {
      lines.push("");
      lines.push("── Additional Accessible Nodes (JEV Routed) ───────────────");
      for (const node of unlinked) {
        lines.push(`  [${node.id}] — ${node.description.slice(0, 45)}`);
      }
    }
  }

  // 3. Fallback node status
  const fallbackNode = data.nodes.find((n) => n.id === "fallback");
  if (fallbackNode) {
    lines.push("");
    lines.push("── Fallback Handling ────────────────────────────────────");
    lines.push(`  🛡️  [fallback]: "${fallbackNode.description.slice(0, 50)}"`);
    lines.push("     Triggers when confidence < 0.35 or ambiguous margin < 0.15");
  }

  return lines.join("\n");
}

/**
 * Generate a Mermaid flowchart diagram string.
 */
export function drawMermaid(target: unknown): string {
  const data = extractGraphData(target);
  const lines: string[] = ["graph TD"];

  lines.push("  %% Felona Voice Graph Flowchart");
  lines.push("  classDef startNode fill:#10b981,stroke:#059669,stroke-width:2px,color:#fff;");
  lines.push("  classDef entryNode fill:#3b82f6,stroke:#2563eb,stroke-width:2px,color:#fff;");
  lines.push("  classDef actionNode fill:#1f2937,stroke:#4b5563,stroke-width:1px,color:#f3f4f6;");
  lines.push("  classDef fallbackNode fill:#dc2626,stroke:#b91c1c,stroke-width:2px,color:#fff;");
  lines.push("");

  const entry = data.entryPoint || (data.nodes.length > 0 ? data.nodes[0].id : "start");
  lines.push(`  START((START)):::startNode --> ${entry}`);

  for (const node of data.nodes) {
    const cleanDesc = node.description
      ? node.description.replace(/"/g, "'").replace(/\n/g, " ")
      : "";
    const label = cleanDesc
      ? `${node.id}["<b>${node.id}</b><br/><small>${cleanDesc}</small>"]`
      : `${node.id}["<b>${node.id}</b>"]`;

    lines.push(`  ${label}`);

    if (node.id === entry) {
      lines.push(`  class ${node.id} entryNode;`);
    } else if (node.id === "fallback") {
      lines.push(`  class ${node.id} fallbackNode;`);
    } else {
      lines.push(`  class ${node.id} actionNode;`);
    }
  }

  if (data.edges.length > 0) {
    lines.push("");
    for (const edge of data.edges) {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  } else {
    lines.push("");
    lines.push("  %% Dynamic JEV Action Space: All nodes accessible via cosine proximity");
    for (const node of data.nodes) {
      if (node.id !== entry) {
        lines.push(`  ${entry} -.->|JEV| ${node.id}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate a Mermaid Live Editor URL with the diagram pre-loaded.
 */
export function toMermaidLiveUrl(target: unknown): string {
  const code = typeof target === "string" ? target : drawMermaid(target);
  const state = {
    code,
    mermaid: '{\n  "theme": "dark"\n}',
    autoSync: true,
    updateDiagram: true,
  };
  const jsonStr = JSON.stringify(state);
  const base64 = Buffer.from(jsonStr).toString("base64");
  return `https://mermaid.live/edit#base64:${base64}`;
}

/**
 * Render complete Markdown documentation for the voice graph.
 * Perfect for viewing in GitHub, VS Code Markdown preview, or documentation sites.
 * Embeds Mermaid flowchart, node table, edge transitions, ASCII diagram, and JEV routing specs.
 */
export function drawMarkdown(target: unknown, options?: { title?: string }): string {
  const data = extractGraphData(target);
  const title = options?.title || data.name || "Felona Voice Graph";
  const mermaid = drawMermaid(data);
  const liveUrl = toMermaidLiveUrl(mermaid);
  const ascii = drawAscii(data, { title });
  const entry = data.entryPoint || (data.nodes.length > 0 ? data.nodes[0].id : "none");
  const fallback = data.nodes.find((n) => n.id === "fallback");

  const lines: string[] = [];
  lines.push(`# 🎙️ ${title}`);
  lines.push("");
  lines.push("> **Auto-generated by Felona Voice** — State Machine & JEV Routing Architecture");
  lines.push("");
  lines.push("### 📊 Overview");
  lines.push("");
  lines.push("| Specification | Details |");
  lines.push("| :--- | :--- |");
  lines.push(`| **Total Nodes** | \`${data.nodes.length}\` |`);
  lines.push(`| **Explicit Transitions** | \`${data.edges.length}\` |`);
  lines.push(`| **Entry Node** | \`🟢 ${entry}\` |`);
  lines.push(`| **Fallback Node** | \`${fallback ? `🛡️ ${fallback.id}` : "None"}\` |`);
  lines.push("| **Routing Engine** | Joint Embedding Vector (JEV) Semantic Matcher |");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### 🗺️ Visual Flowchart");
  lines.push("");
  lines.push("```mermaid");
  lines.push(mermaid);
  lines.push("```");
  lines.push("");
  lines.push(`> [🌐 Open and interactively edit in Mermaid Live Editor](${liveUrl})`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### 📋 Node Catalog");
  lines.push("");
  lines.push("| Node ID | Role | Description |");
  lines.push("| :--- | :--- | :--- |");
  for (const node of data.nodes) {
    let role = "Action Node";
    if (node.id === entry) role = "🟢 Entry Point";
    else if (node.id === "fallback") role = "🛡️ Fallback";
    const desc = (node.description || "—").replace(/\|/g, "\\|");
    lines.push(`| \`${node.id}\` | ${role} | ${desc} |`);
  }
  lines.push("");

  if (data.edges.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("### 🔀 Directed State Transitions");
    lines.push("");
    lines.push("| Source Node | Allowed Target Node(s) |");
    lines.push("| :--- | :--- |");
    const edgeMap = new Map<string, string[]>();
    for (const e of data.edges) {
      if (!edgeMap.has(e.from)) edgeMap.set(e.from, []);
      edgeMap.get(e.from)!.push(`\`${e.to}\``);
    }
    for (const [from, toList] of edgeMap.entries()) {
      lines.push(`| \`${from}\` | ${toList.join(", ")} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("### 🖥️ Terminal Diagram (Plaintext)");
  lines.push("");
  lines.push("```text");
  lines.push(ascii);
  lines.push("```");
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("### 🛡️ JEV Dynamic Routing & Fallback Policy");
  lines.push("- **Semantic Vector Matching**: When a caller speaks, JEV evaluates similarity against accessible actions in real-time.");
  lines.push("- **Confidence Threshold**: If top similarity `< 0.35`, the utterance immediately routes to `fallback`.");
  lines.push("- **Ambiguity Margin**: If top candidate `< 0.55` and margin to second candidate `< 0.15`, the engine safely routes to `fallback`.");
  lines.push("- **Standard Fallback Response**: *\"Sorry, I am not able to understand.\"*");
  lines.push("");

  return lines.join("\n");
}

export const generateGraphMarkdown = drawMarkdown;

/**
 * Generate a self-contained, interactive HTML visualizer.
 * Contains interactive SVG layout, node inspector, live JEV test utterance simulator, and Mermaid export.
 */
export function generateGraphHtml(target: unknown, options?: { title?: string }): string {
  const data = extractGraphData(target);
  const title = options?.title || data.name || "Felona Voice Graph";
  const mermaidCode = drawMermaid(data);
  const mermaidLiveUrl = toMermaidLiveUrl(mermaidCode);
  const graphJson = JSON.stringify(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Felona Visualizer</title>
  <style>
    :root {
      --bg: #09090b;
      --card-bg: #18181b;
      --card-border: #27272a;
      --card-hover: #3f3f46;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent-blue: #3b82f6;
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --accent-purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: #111114;
      border-bottom: 1px solid var(--card-border);
      padding: 14px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 10;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      background: #27272a;
      color: var(--muted);
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 9999px;
      font-family: monospace;
    }
    .header-actions {
      display: flex;
      gap: 10px;
    }
    button, .btn-link {
      background: #27272a;
      color: #fff;
      border: 1px solid #3f3f46;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    button:hover, .btn-link:hover {
      background: #3f3f46;
      border-color: #52525b;
    }
    .btn-primary {
      background: #2563eb;
      border-color: #1d4ed8;
    }
    .btn-primary:hover {
      background: #1d4ed8;
    }
    main {
      flex: 1;
      display: flex;
      position: relative;
      overflow: hidden;
    }
    #canvas-container {
      flex: 1;
      position: relative;
      background: radial-gradient(circle, #1c1c22 1px, transparent 1px);
      background-size: 24px 24px;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
    }
    svg#graph-svg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .nodes-layer {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      gap: 28px;
      max-width: 900px;
      justify-content: center;
      z-index: 2;
    }
    .node-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px 20px;
      width: 260px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .node-card:hover {
      border-color: var(--card-hover);
      transform: translateY(-2px);
    }
    .node-card.active {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.4), 0 8px 20px rgba(0,0,0,0.5);
    }
    .node-card.highlighted {
      border-color: var(--accent-green);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      50% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
    }
    .node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .node-id {
      font-weight: 700;
      font-size: 15px;
      font-family: monospace;
      color: #fff;
    }
    .node-tag {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tag-entry { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    .tag-fallback { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .tag-action { background: rgba(161, 161, 170, 0.15); color: #d4d4d8; }
    .node-desc {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.4;
    }
    aside#sidebar {
      width: 380px;
      background: #111114;
      border-left: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      z-index: 5;
    }
    .sidebar-tabs {
      display: flex;
      border-bottom: 1px solid var(--card-border);
    }
    .tab-btn {
      flex: 1;
      padding: 12px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      text-align: center;
      justify-content: center;
    }
    .tab-btn.active {
      color: #fff;
      border-bottom-color: var(--accent-blue);
      background: rgba(59, 130, 246, 0.05);
    }
    .tab-content {
      padding: 20px;
      flex: 1;
      overflow-y: auto;
    }
    .simulator-box {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .sim-input {
      width: 100%;
      background: #1e1e24;
      border: 1px solid var(--card-border);
      padding: 10px 14px;
      border-radius: 6px;
      color: #fff;
      font-size: 13px;
      outline: none;
    }
    .sim-input:focus {
      border-color: var(--accent-blue);
    }
    .sim-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      background: #1e1e24;
      border: 1px solid #27272a;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--muted);
      cursor: pointer;
    }
    .chip:hover {
      background: #27272a;
      color: #fff;
    }
    .sim-result {
      background: #18181b;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px;
      margin-top: 12px;
    }
    .candidate-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 12px;
      font-family: monospace;
      border-bottom: 1px solid #27272a;
    }
    .candidate-row:last-child { border-bottom: none; }
    pre.code-block {
      background: #09090b;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px;
      font-family: monospace;
      font-size: 12px;
      color: #a1a1aa;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 320px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <h2 style="font-size: 16px; font-weight: 700;">🎙️ ${title}</h2>
      <span class="badge">${data.nodes.length} Nodes</span>
      <span class="badge">${data.edges.length} Edges</span>
    </div>
    <div class="header-actions">
      <a href="${mermaidLiveUrl}" target="_blank" class="btn-link">
        <span>🌐 Mermaid Live</span>
      </a>
      <button onclick="copyMermaid()">
        <span>📋 Copy Mermaid</span>
      </button>
    </div>
  </header>

  <main>
    <div id="canvas-container">
      <div class="nodes-layer" id="nodesLayer"></div>
    </div>

    <aside id="sidebar">
      <div class="sidebar-tabs">
        <button class="tab-btn active" onclick="switchTab('simulator')">Simulator</button>
        <button class="tab-btn" onclick="switchTab('inspector')">Node Details</button>
        <button class="tab-btn" onclick="switchTab('mermaid')">Mermaid</button>
      </div>

      <div id="tab-simulator" class="tab-content">
        <h4 style="font-size: 14px; margin-bottom: 8px;">JEV Neural Action Predictor</h4>
        <p style="font-size: 12px; color: var(--muted); margin-bottom: 14px;">
          Type any user utterance to simulate instant next-node prediction:
        </p>
        <div class="simulator-box">
          <input type="text" id="simInput" class="sim-input" placeholder="e.g. where is my package?" onkeydown="if(event.key==='Enter') runSimulation()">
          <button class="btn-primary" onclick="runSimulation()">Predict Next Node</button>
          
          <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Quick prompts:</div>
          <div class="sim-chips">
            <span class="chip" onclick="quickPrompt('Hello, I need help')">Greeting</span>
            <span class="chip" onclick="quickPrompt('Where is my package?')">Order Track</span>
            <span class="chip" onclick="quickPrompt('Can I get a refund?')">Refund</span>
            <span class="chip" onclick="quickPrompt('What is the weather in Paris?')">Irrelevant / Fallback</span>
          </div>

          <div id="simResult" class="sim-result" style="display: none;">
            <div style="font-size: 11px; text-transform: uppercase; color: var(--muted); margin-bottom: 6px;">Predicted Node</div>
            <div id="simWinner" style="font-size: 16px; font-weight: 700; color: var(--accent-green); margin-bottom: 10px;"></div>
            <div id="simCandidates"></div>
          </div>
        </div>
      </div>

      <div id="tab-inspector" class="tab-content" style="display: none;">
        <h4 id="inspectNodeTitle" style="font-size: 15px; font-family: monospace; margin-bottom: 8px;">Select a Node</h4>
        <div id="inspectContent" style="font-size: 13px; color: var(--muted); line-height: 1.5;">
          Click on any node in the canvas to inspect its parameters, description, incoming and outgoing transitions.
        </div>
      </div>

      <div id="tab-mermaid" class="tab-content" style="display: none;">
        <h4 style="font-size: 14px; margin-bottom: 8px;">Mermaid Flowchart</h4>
        <pre class="code-block" id="mermaidCode">${mermaidCode}</pre>
        <div style="margin-top: 14px;">
          <button onclick="copyMermaid()" style="width: 100%; justify-content: center;">Copy Mermaid Syntax</button>
        </div>
      </div>
    </aside>
  </main>

  <script>
    const graphData = ${graphJson};
    let activeNodeId = null;

    function renderNodes() {
      const layer = document.getElementById("nodesLayer");
      layer.innerHTML = "";

      graphData.nodes.forEach(node => {
        const card = document.createElement("div");
        card.className = "node-card";
        card.id = "node-" + node.id;
        card.onclick = () => selectNode(node.id);

        let tagClass = "tag-action";
        let tagLabel = "Action";
        if (node.id === graphData.entryPoint) {
          tagClass = "tag-entry";
          tagLabel = "Entry";
        } else if (node.id === "fallback") {
          tagClass = "tag-fallback";
          tagLabel = "Fallback";
        }

        card.innerHTML = \`
          <div class="node-header">
            <span class="node-id">\${node.id}</span>
            <span class="node-tag \${tagClass}">\${tagLabel}</span>
          </div>
          <div class="node-desc">\${node.description || "No description provided."}</div>
        \`;
        layer.appendChild(card);
      });
    }

    function selectNode(id) {
      activeNodeId = id;
      document.querySelectorAll(".node-card").forEach(c => c.classList.remove("active"));
      const card = document.getElementById("node-" + id);
      if (card) card.classList.add("active");

      const node = graphData.nodes.find(n => n.id === id);
      if (!node) return;

      switchTab("inspector");
      document.getElementById("inspectNodeTitle").innerText = "Node: " + node.id;

      const outgoing = graphData.edges.filter(e => e.from === id).map(e => e.to);
      const incoming = graphData.edges.filter(e => e.to === id).map(e => e.from);

      document.getElementById("inspectContent").innerHTML = \`
        <div style="margin-bottom: 12px;">
          <b style="color: #fff;">Description:</b><br/>
          \${node.description || "—"}
        </div>
        <div style="margin-bottom: 12px;">
          <b style="color: #fff;">Outgoing Transitions (\${outgoing.length}):</b><br/>
          \${outgoing.length > 0 ? outgoing.map(t => \`<code style="background: #27272a; padding: 2px 6px; border-radius: 4px; font-size: 12px;">\${t}</code>\`).join(" ") : "<span style='color:#71717a;'>Dynamic JEV Action Space</span>"}
        </div>
        <div style="margin-bottom: 12px;">
          <b style="color: #fff;">Incoming Transitions (\${incoming.length}):</b><br/>
          \${incoming.length > 0 ? incoming.map(t => \`<code style="background: #27272a; padding: 2px 6px; border-radius: 4px; font-size: 12px;">\${t}</code>\`).join(" ") : (id === graphData.entryPoint ? "<span style='color:#60a5fa;'>START (Entry Point)</span>" : "<span style='color:#71717a;'>Dynamic JEV Action Space</span>")}
        </div>
      \`;
    }

    function switchTab(name) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.style.display = "none");

      const targetBtn = Array.from(document.querySelectorAll(".tab-btn")).find(b => b.innerText.toLowerCase().includes(name.slice(0, 4)));
      if (targetBtn) targetBtn.classList.add("active");
      const content = document.getElementById("tab-" + name);
      if (content) content.style.display = "block";
    }

    function quickPrompt(text) {
      document.getElementById("simInput").value = text;
      runSimulation();
    }

    function runSimulation() {
      const text = document.getElementById("simInput").value.trim().toLowerCase();
      if (!text) return;

      const words = text.split(/\\s+/);
      const scores = graphData.nodes.map(node => {
        const descWords = (node.id + " " + (node.description || "")).toLowerCase().split(/\\s+/);
        let matchCount = 0;
        for (const w of words) {
          if (w.length > 2 && descWords.some(dw => dw.includes(w) || w.includes(dw))) {
            matchCount += 1;
          }
        }
        let score = (matchCount / Math.max(1, words.length)) * 0.8 + 0.15;
        if (node.id === "fallback" && matchCount === 0) {
          score = 0.94; // fallback triggers on zero domain overlap
        }
        return { node: node.id, score: Number(score.toFixed(3)) };
      });

      scores.sort((a, b) => b.score - a.score);
      const winner = scores[0];

      document.querySelectorAll(".node-card").forEach(c => c.classList.remove("highlighted"));
      const winnerCard = document.getElementById("node-" + winner.node);
      if (winnerCard) {
        winnerCard.classList.add("highlighted");
        winnerCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }

      const resBox = document.getElementById("simResult");
      resBox.style.display = "block";
      document.getElementById("simWinner").innerText = "🎯 " + winner.node + " (" + (winner.score * 100).toFixed(1) + "%)";

      const candBox = document.getElementById("simCandidates");
      candBox.innerHTML = scores.map(s => \`
        <div class="candidate-row">
          <span>\${s.node}</span>
          <span style="color: \${s.score > 0.5 ? 'var(--accent-green)' : 'var(--muted)'}">\${(s.score * 100).toFixed(1)}%</span>
        </div>
      \`).join("");
    }

    function copyMermaid() {
      const code = document.getElementById("mermaidCode").innerText;
      navigator.clipboard.writeText(code).then(() => {
        alert("Mermaid diagram copied to clipboard!");
      });
    }

    renderNodes();
    if (graphData.entryPoint) selectNode(graphData.entryPoint);
  </script>
</body>
</html>`;
}

/**
 * Open a file in the system default browser.
 */
function openInBrowser(filePath: string): void {
  const absPath = path.resolve(filePath);
  const platform = process.platform;
  let cmd = "";

  if (platform === "darwin") {
    cmd = `open "${absPath}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${absPath}"`;
  } else {
    // Linux / BSD
    cmd = `xdg-open "${absPath}" || sensible-browser "${absPath}" || google-chrome "${absPath}" || firefox "${absPath}"`;
  }

  exec(cmd, () => {
    // Silently handle
  });
}

/**
 * Primary visualizer tool for Felona Voice.
 *
 * Visualizes any VoiceGraph, CompiledVoiceGraph, FelAgent, or GraphData in terminal (ASCII),
 * generates Mermaid diagrams, or launches an interactive HTML visualizer.
 *
 * @example
 * ```typescript
 * import { visualizeGraph } from "felona-voice";
 *
 * // Print ASCII in terminal:
 * await visualizeGraph(workflow);
 *
 * // Open interactive browser visualizer:
 * await visualizeGraph(workflow, { open: true });
 * ```
 */
export async function visualizeGraph(
  target: unknown,
  options?: VisualizeOptions
): Promise<VisualizeResult> {
  const data = extractGraphData(target);
  const title = options?.title || data.name || "Voice Graph";
  const format = options?.format || (options?.open ? "html" : "ascii");
  const shouldPrint = options?.print !== false;

  const ascii = drawAscii(data, { title });
  const mermaid = drawMermaid(data);
  const markdown = drawMarkdown(data, { title });
  const url = toMermaidLiveUrl(mermaid);
  const html = generateGraphHtml(data, { title });

  let filePath: string | undefined;

  if (format === "markdown" || format === "md" || (options?.outputPath && options.outputPath.endsWith(".md"))) {
    filePath = options?.outputPath || path.resolve(process.cwd(), "felona-graph.md");
    fs.writeFileSync(filePath, markdown, "utf-8");
  } else if (format === "html" || options?.open || (options?.outputPath && options.outputPath.endsWith(".html"))) {
    filePath = options?.outputPath || path.resolve(process.cwd(), "felona-graph.html");
    fs.writeFileSync(filePath, html, "utf-8");

    if (options?.open) {
      openInBrowser(filePath);
    }
  }

  if (shouldPrint) {
    if (format === "ascii") {
      console.log(ascii);
    } else if (format === "markdown" || format === "md") {
      if (filePath) {
        console.log(`\n✨ Graph Markdown file generated: ${filePath}`);
      } else {
        console.log(markdown);
      }
    } else if (format === "mermaid") {
      console.log(mermaid);
    } else if (format === "url") {
      console.log(url);
    } else if (format === "html" && filePath) {
      console.log(`\n✨ Graph HTML visualization generated: ${filePath}`);
    }
  }

  return {
    ascii,
    mermaid,
    markdown,
    url,
    html,
    filePath,
  };
}
