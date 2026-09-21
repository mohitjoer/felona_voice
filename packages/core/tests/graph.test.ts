import { describe, it, expect } from "vitest";
import { VoiceGraph, START, END } from "../src/index.js";

interface TestState {
  orderId?: string;
  customerName?: string;
  count?: number;
}

describe("VoiceGraph (LangGraph style)", () => {
  it("compiles and invokes with LangGraph-style workflow", async () => {
    const workflow = new VoiceGraph<TestState>()
      .setState({ customerName: "Sarah", orderId: "ACM-100" })
      .addNode("greet", {
        description: "Welcome caller warmly and identify customer",
        run: (state) => `Hi ${state.customerName || "there"}! How can I assist you?`,
      })
      .addNode("order_status", {
        description: "Check delivery status and tracking for order ID",
        run: (state) => `Order ${state.orderId} is out for delivery today.`,
      })
      .addNode("fallback", {
        description: "Out of scope queries, speech comments, weather, or unhandled requests",
        run: "Sorry, I am not able to understand that. How can I assist with your order?",
      })
      .addEdge("greet", "order_status")
      .setEntryPoint("greet");

    const graph = await workflow.compile();

    // 1. Initial Greeting turn
    const out1 = await graph.invoke({ message: "hello there" });
    expect(out1.node).toBe("greet");
    expect(out1.response).toContain("Hi Sarah!");

    // 2. Order status turn
    const out2 = await graph.invoke({ message: "where is my package" });
    expect(out2.node).toBe("order_status");
    expect(out2.response).toContain("ACM-100");

    // 3. Fallback for out-of-scope query
    const out3 = await graph.invoke({ message: "what is the capital of France" });
    expect(out3.node).toBe("fallback");
    expect(out3.response).toContain("Sorry, I am not able to understand");
  });

  it("supports state updates returned from node run functions", async () => {
    const workflow = new VoiceGraph<TestState>()
      .setState({ count: 1 })
      .addNode("increment", {
        description: "Increment counter and progress state",
        run: (state) => ({
          count: (state.count || 0) + 1,
          response: `Counter is now ${(state.count || 0) + 1}`,
        }),
      });

    const graph = await workflow.compile();
    const res = await graph.invoke({ message: "increment counter" });

    expect(res.state.count).toBe(2);
    expect(res.response).toBe("Counter is now 2");
  });

  it("generates valid Mermaid diagram with drawMermaid()", async () => {
    const workflow = new VoiceGraph()
      .addNode("node_a", { description: "First node", run: "Response A" })
      .addNode("node_b", { description: "Second node", run: "Response B" })
      .addEdge("node_a", "node_b")
      .setEntryPoint("node_a");

    const graph = await workflow.compile();
    const mermaid = graph.drawMermaid();

    expect(mermaid).toContain("graph TD");
    expect(mermaid).toContain("START[START] --> node_a");
    expect(mermaid).toContain("node_a --> node_b");
  });

  it("exports raw graph data via getGraph() for UI visualization", async () => {
    const workflow = new VoiceGraph()
      .addNode("start_node", "Start here")
      .addNode("next_node", "Next step")
      .addEdge("start_node", "next_node")
      .setEntryPoint("start_node");

    const graph = await workflow.compile();
    const data = graph.getGraph();

    expect(data.nodes.length).toBeGreaterThanOrEqual(2);
    expect(data.edges.some((e) => e.from === "start_node" && e.to === "next_node")).toBe(true);
    expect(data.entryPoint).toBe("start_node");
  });

  it("simulates a multi-turn conversation", async () => {
    const workflow = new VoiceGraph<TestState>()
      .setState({ customerName: "Alex" })
      .addNode("greet", {
        description: "Welcome caller",
        run: (s) => `Hello ${s.customerName}!`,
      })
      .addNode("help", {
        description: "Help with order questions",
        run: "I can help with tracking or returns.",
      });

    const graph = await workflow.compile();
    const turns = await graph.simulate([
      "hello",
      "what can you help me with",
    ]);

    expect(turns.length).toBe(2);
    expect(turns[0].node).toBe("greet");
    expect(turns[1].node).toBe("help");
  });
});
