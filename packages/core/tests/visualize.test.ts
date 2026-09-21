import { describe, it, expect } from "vitest";
import {
  VoiceGraph,
  visualizeGraph,
  drawAscii,
  drawMermaid,
  toMermaidLiveUrl,
  generateGraphHtml,
  createSupportAgent,
  FelAgent,
  defineAction,
} from "../src/index.js";

describe("Graph Visualization Tools", () => {
  it("draws ASCII diagram from uncompiled VoiceGraph", () => {
    const workflow = new VoiceGraph()
      .addNode("greet", { description: "Greet caller warmly", run: "Hello!" })
      .addNode("order_status", { description: "Check shipping details", run: "Shipped!" })
      .addNode("fallback", { description: "Out of scope questions", run: "Sorry, I am not able to understand." })
      .addEdge("greet", "order_status")
      .setEntryPoint("greet");

    const ascii = workflow.drawAscii();
    expect(ascii).toContain("🎙️");
    expect(ascii).toContain("● [START]");
    expect(ascii).toContain("greet");
    expect(ascii).toContain("order_status");
    expect(ascii).toContain("fallback");
    expect(ascii).toContain("Entry Point");
    expect(ascii).toContain("Directed Transitions");
  });

  it("draws ASCII diagram from compiled VoiceGraph", async () => {
    const workflow = new VoiceGraph()
      .addNode("greet", "Welcome")
      .addNode("billing", "Billing help")
      .setEntryPoint("greet");

    const compiled = await workflow.compile();
    const ascii = compiled.drawAscii();
    expect(ascii).toContain("greet");
    expect(ascii).toContain("billing");
  });

  it("draws ASCII diagram from FelAgent action space", () => {
    const agent = new FelAgent({
      name: "Support Agent",
      actions: [
        defineAction({ id: "support", description: "General support", handler: async () => "help" }),
        defineAction({ id: "sales", description: "Product purchasing", handler: async () => "buy" }),
      ],
    });

    const ascii = agent.drawAscii();
    expect(ascii).toContain("Support Agent");
    expect(ascii).toContain("support");
    expect(ascii).toContain("sales");
  });

  it("generates valid Mermaid diagram and Live Editor URL", () => {
    const workflow = new VoiceGraph()
      .addNode("greet", "Welcome")
      .addNode("shipping", "Shipping ETA")
      .addEdge("greet", "shipping")
      .setEntryPoint("greet");

    const mermaid = workflow.drawMermaid();
    expect(mermaid).toContain("graph TD");
    expect(mermaid).toContain("START((START)):::startNode --> greet");
    expect(mermaid).toContain("greet --> shipping");

    const liveUrl = workflow.toMermaidLiveUrl();
    expect(liveUrl).toMatch(/^https:\/\/mermaid\.live\/edit#base64:/);
  });

  it("generates self-contained interactive HTML visualizer", () => {
    const workflow = new VoiceGraph()
      .addNode("greet", { description: "Welcome caller", run: "Hello!" })
      .addNode("order_status", { description: "Track order", run: "Order status" })
      .addNode("fallback", { description: "Unrecognized queries", run: "Sorry" })
      .setEntryPoint("greet");

    const html = generateGraphHtml(workflow, { title: "Custom Title" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Custom Title — Felona Visualizer");
    expect(html).toContain("JEV Neural Action Predictor");
    expect(html).toContain("greet");
    expect(html).toContain("order_status");
  });

  it("visualizeGraph runs programmatic export", async () => {
    const workflow = new VoiceGraph()
      .addNode("greet", "Hello")
      .addNode("faq", "Answers")
      .setEntryPoint("greet");

    const result = await workflow.visualize({
      format: "ascii",
      print: false,
    });

    expect(result.ascii).toContain("greet");
    expect(result.mermaid).toContain("graph TD");
    expect(result.url).toContain("https://mermaid.live");
    expect(result.html).toContain("<!DOCTYPE html>");
  });

  it("generates comprehensive Markdown documentation", () => {
    const workflow = new VoiceGraph()
      .addNode("greet", { description: "Welcome caller", run: "Hello!" })
      .addNode("order_status", { description: "Track order", run: "Order status" })
      .addNode("fallback", { description: "Unrecognized queries", run: "Sorry" })
      .addEdge("greet", "order_status")
      .setEntryPoint("greet");

    const md = workflow.drawMarkdown({ title: "Acme Support Graph" });
    expect(md).toContain("# 🎙️ Acme Support Graph");
    expect(md).toContain("```mermaid");
    expect(md).toContain("### 📋 Node Catalog");
    expect(md).toContain("### 🔀 Directed State Transitions");
    expect(md).toContain("### 🖥️ Terminal Diagram");
    expect(md).toContain("### 🛡️ JEV Dynamic Routing & Fallback Policy");
    expect(md).toContain("greet");
    expect(md).toContain("order_status");
  });

  it("createSupportAgent has full visualization capabilities", () => {
    const agent = createSupportAgent({
      actions: {
        order_status: "Your order is arriving soon",
      },
    });

    const ascii = agent.drawAscii();
    expect(ascii).toContain("order_status");
    expect(ascii).toContain("fallback");
    expect(agent.drawMermaid()).toContain("graph TD");
    expect(agent.drawMarkdown()).toContain("# 🎙️ Acme Support");
  });
});
