import { JEVEngine } from "../jev/engine.js";
import { FastSemanticEmbeddingProvider } from "../jev/fast-embeddings.js";
import { ConversationMemory } from "../memory/context.js";
import { defineAction, FelAgent } from "../agent.js";
import {
  drawAscii,
  drawMermaid,
  drawMarkdown,
  toMermaidLiveUrl,
  visualizeGraph,
  type GraphData,
  type VisualizeOptions,
  type VisualizeResult,
} from "./visualize.js";
import type {
  AgentAction,
  ConversationContext,
  EmbeddingProvider,
  Session,
} from "../types.js";

export const START = "__start__";
export const END = "__end__";

export interface GraphRunContext<TState> {
  message: string;
  state: TState;
  history: Array<{ role: "user" | "agent"; content: string; node?: string }>;
  confidence: number;
  candidates: Array<{ actionId: string; score: number }>;
}

export type NodeRunResult<TState> =
  | string
  | (Partial<TState> & { response?: string })
  | void;

export type NodeRunFn<TState> = (
  state: TState,
  context: GraphRunContext<TState>
) => Promise<NodeRunResult<TState>> | NodeRunResult<TState>;

export interface NodeOptions<TState> {
  description: string;
  run: string | NodeRunFn<TState>;
  metadata?: Record<string, unknown>;
}

export interface GraphInvokeInput<TState> {
  message: string;
  state?: Partial<TState>;
  sessionId?: string;
}

export interface GraphInvokeOutput<TState> {
  response: string;
  node: string;
  confidence: number;
  state: TState;
  candidates: Array<{ actionId: string; score: number }>;
  history: Array<{ role: "user" | "agent"; content: string; node?: string }>;
}

export type { GraphData, VisualizeOptions, VisualizeResult };

/**
 * CompiledVoiceGraph — A runnable, compiled stateful voice graph powered by JEV.
 *
 * Implements LangGraph-style `.invoke()`, `.simulate()`, and `.drawMermaid()`.
 */
export class CompiledVoiceGraph<TState extends Record<string, unknown> = Record<string, unknown>> {
  private readonly nodes: Map<string, NodeOptions<TState>>;
  private readonly edges: Map<string, Set<string>>;
  private readonly entryPoint: string;
  private readonly jevEngine: JEVEngine;
  private readonly defaultState: TState;
  private readonly sessionStateMap = new Map<string, { state: TState; memory: ConversationMemory; currentNode?: string }>();

  constructor(options: {
    nodes: Map<string, NodeOptions<TState>>;
    edges: Map<string, Set<string>>;
    entryPoint: string;
    jevEngine: JEVEngine;
    initialState: TState;
  }) {
    this.nodes = options.nodes;
    this.edges = options.edges;
    this.entryPoint = options.entryPoint;
    this.jevEngine = options.jevEngine;
    this.defaultState = options.initialState;
  }

  /**
   * Run a single conversation turn through the graph (LangGraph invoke pattern).
   */
  async invoke(input: string | GraphInvokeInput<TState>): Promise<GraphInvokeOutput<TState>> {
    const message = typeof input === "string" ? input : input.message;
    const sessionId = (typeof input === "object" && input.sessionId) ? input.sessionId : "default";

    let session = this.sessionStateMap.get(sessionId);
    if (!session) {
      session = {
        state: { ...this.defaultState },
        memory: new ConversationMemory({ maxTurns: 30 }),
        currentNode: undefined,
      };
      this.sessionStateMap.set(sessionId, session);
    }

    // Merge any updated state passed in input
    if (typeof input === "object" && input.state) {
      Object.assign(session.state, input.state);
    }

    const { state, memory } = session;

    // 1. Check constrained edge candidates
    let allowedNodeIds: string[];
    if (session.currentNode && this.edges.has(session.currentNode) && (this.edges.get(session.currentNode)!.size > 0)) {
      allowedNodeIds = Array.from(this.edges.get(session.currentNode)!);
      // Always allow fallback if defined
      if (this.nodes.has("fallback") && !allowedNodeIds.includes("fallback")) {
        allowedNodeIds.push("fallback");
      }
    } else {
      allowedNodeIds = Array.from(this.nodes.keys());
    }

    // 2. Build conversational context for JEV
    const fakeSession: Session = {
      id: sessionId,
      startedAt: new Date(),
      metadata: {},
      state: "active",
    };

    const context = memory.buildContext(fakeSession, "You are an intelligent voice agent.", message);

    // 3. JEV Decision
    const match = await this.jevEngine.decide(context);

    // 4. Resolve target node (filter by allowed edges if constrained)
    let selectedNodeId = match.action.id;
    if (!allowedNodeIds.includes(selectedNodeId)) {
      const bestAllowed = match.candidates.find((c) => allowedNodeIds.includes(c.actionId));
      selectedNodeId = bestAllowed ? bestAllowed.actionId : (this.nodes.has("fallback") ? "fallback" : allowedNodeIds[0]);
    }

    const nodeDef = this.nodes.get(selectedNodeId) || this.nodes.get(this.entryPoint) || this.nodes.get("fallback")!;
    session.currentNode = selectedNodeId;

    // 5. Execute node handler
    const historyList = memory.getRecentTurns(20).map((t) => ({
      role: t.role as "user" | "agent",
      content: t.content,
      node: t.actionId,
    }));

    const runCtx: GraphRunContext<TState> = {
      message,
      state,
      history: historyList,
      confidence: match.confidence,
      candidates: match.candidates,
    };

    let responseText = "";
    if (typeof nodeDef.run === "string") {
      responseText = nodeDef.run;
    } else {
      const result = await nodeDef.run(state, runCtx);
      if (typeof result === "string") {
        responseText = result;
      } else if (typeof result === "object" && result !== null) {
        if (result.response) responseText = result.response;
        // Merge returned state keys
        const { response: _r, ...stateUpdates } = result;
        Object.assign(state, stateUpdates);
      }
    }

    if (!responseText) {
      responseText = `Completed node: ${selectedNodeId}`;
    }

    // 6. Record turns in memory
    memory.addTurn({ role: "user", content: message, timestampMs: Date.now() });
    memory.addTurn({
      role: "agent",
      content: responseText,
      timestampMs: Date.now(),
      actionId: selectedNodeId,
      confidence: match.confidence,
    });

    return {
      response: responseText,
      node: selectedNodeId,
      confidence: Number(match.confidence.toFixed(4)),
      state,
      candidates: match.candidates.map((c) => ({
        actionId: c.actionId,
        score: Number(c.score.toFixed(4)),
      })),
      history: memory.getRecentTurns(20).map((t) => ({
        role: t.role as "user" | "agent",
        content: t.content,
        node: t.actionId,
      })),
    };
  }

  /**
   * Run a multi-turn conversation simulation.
   */
  async simulate(messages: string[], initialState?: Partial<TState>, sessionId?: string): Promise<Array<GraphInvokeOutput<TState>>> {
    const results: Array<GraphInvokeOutput<TState>> = [];
    const sid = sessionId ?? `sim-${Date.now()}`;
    for (let i = 0; i < messages.length; i++) {
      const res = await this.invoke({
        message: messages[i],
        state: i === 0 ? initialState : undefined,
        sessionId: sid,
      });
      results.push(res);
    }
    return results;
  }

  /**
   * Export the graph structure as a Mermaid flowchart (similar to LangGraph .drawMermaid()).
   */
  drawMermaid(): string {
    const lines: string[] = ["graph TD"];

    lines.push(`  START[START] --> ${this.entryPoint}`);

    for (const [nodeId, options] of this.nodes.entries()) {
      const label = options.description ? `${nodeId}["${nodeId}<br/><small>${options.description}</small>"]` : nodeId;
      lines.push(`  ${label}`);
    }

    for (const [fromNode, targetSet] of this.edges.entries()) {
      for (const toNode of targetSet) {
        lines.push(`  ${fromNode} --> ${toNode}`);
      }
    }

    // Fallback indicator if unconstrained
    if (this.edges.size === 0) {
      lines.push("  %% Dynamic JEV Neural Routing: All nodes accessible by semantic proximity");
    }

    return lines.join("\n");
  }

  /**
   * Get raw graph data for UI rendering and visualization.
   */
  getGraph(): GraphData {
    const nodes = Array.from(this.nodes.entries()).map(([id, opt]) => ({
      id,
      description: opt.description,
      metadata: opt.metadata,
    }));

    const edges: Array<{ from: string; to: string }> = [];
    for (const [from, targetSet] of this.edges.entries()) {
      for (const to of targetSet) {
        edges.push({ from, to });
      }
    }

    return {
      nodes,
      edges,
      entryPoint: this.entryPoint,
    };
  }

  /**
   * Render an ASCII directed graph in the terminal.
   */
  drawAscii(options?: { title?: string }): string {
    return drawAscii(this.getGraph(), options);
  }

  /**
   * Generate a direct Mermaid Live Editor link.
   */
  toMermaidLiveUrl(): string {
    return toMermaidLiveUrl(this.drawMermaid());
  }

  /**
   * Generate complete Markdown documentation for the compiled graph.
   */
  drawMarkdown(options?: { title?: string }): string {
    return drawMarkdown(this.getGraph(), options);
  }

  /**
   * Visualize the compiled graph in terminal (ASCII), as Markdown, or as an interactive HTML visualizer.
   */
  async visualize(options?: VisualizeOptions): Promise<VisualizeResult> {
    return visualizeGraph(this.getGraph(), options);
  }

  /**
   * Convert compiled graph into a full FelAgent ready for live audio WebSocket streaming.
   */
  toAgent(agentOptions?: { name?: string; sttApiKey?: string; ttsApiKey?: string }): FelAgent {
    const actions: AgentAction[] = Array.from(this.nodes.entries()).map(([id, opt]) =>
      defineAction({
        id,
        description: `${id}: ${opt.description}`,
        handler: async (ctx) => {
          const runCtx: GraphRunContext<TState> = {
            message: ctx.conversation.currentUtterance,
            state: ctx.memory.getSlots() as TState,
            history: ctx.memory.getRecentTurns(20).map((t) => ({
              role: t.role as "user" | "agent",
              content: t.content,
              node: t.actionId,
            })),
            confidence: 0.95,
            candidates: [],
          };
          if (typeof opt.run === "string") return opt.run;
          const res = await opt.run(runCtx.state, runCtx);
          if (typeof res === "string") return res;
          if (typeof res === "object" && res?.response) return res.response;
          return `Action completed: ${id}`;
        },
      })
    );

    return new FelAgent({
      name: agentOptions?.name ?? "Graph Agent",
      actions,
      stt: agentOptions?.sttApiKey ? { provider: "deepgram", apiKey: agentOptions.sttApiKey } : undefined,
      tts: agentOptions?.ttsApiKey ? { provider: "deepgram", apiKey: agentOptions.ttsApiKey, voice: "aura-asteria-en" } : undefined,
    });
  }
}

/**
 * VoiceGraph — LangGraph-inspired stateful conversational graph builder for voice agents.
 *
 * @example
 * ```typescript
 * import { VoiceGraph, START } from "felona-voice";
 *
 * interface SupportState {
 *   orderId?: string;
 *   customerName?: string;
 * }
 *
 * const workflow = new VoiceGraph<SupportState>()
 *   .addNode("greet", {
 *     description: "Welcome caller warmly and ask how to help",
 *     run: (state) => `Hello ${state.customerName || "there"}! How can I help?`,
 *   })
 *   .addNode("order_status", {
 *     description: "Inquire about shipment location, courier, and transit delivery date",
 *     run: (state) => `Order ${state.orderId || "ACM-9281"} is out for delivery today!`,
 *   })
 *   .addNode("fallback", {
 *     description: "Out of scope questions, trivia, weather, or unhandled requests",
 *     run: "Sorry, I am not able to understand that. How can I assist with your order?",
 *   })
 *   .addEdge("greet", "order_status")
 *   .setEntryPoint("greet");
 *
 * const graph = await workflow.compile();
 * const reply = await graph.invoke({ message: "where is my order" });
 * console.log(reply.response); // "Order ACM-9281 is out for delivery today!"
 * ```
 */
export class VoiceGraph<TState extends Record<string, unknown> = Record<string, unknown>> {
  private nodes = new Map<string, NodeOptions<TState>>();
  private edges = new Map<string, Set<string>>();
  private entryPoint?: string;
  private initialState: TState = {} as TState;
  private embeddingProvider?: EmbeddingProvider;
  private confidenceThreshold = 0.35;

  /**
   * Set initial default state channels.
   */
  setState(initialState: TState): this {
    this.initialState = { ...initialState };
    return this;
  }

  /**
   * Add a conversational node to the graph.
   */
  addNode(
    id: string,
    options: NodeOptions<TState> | string
  ): this {
    if (typeof options === "string") {
      this.nodes.set(id, {
        description: `${id} action node`,
        run: options,
      });
    } else {
      this.nodes.set(id, options);
    }
    return this;
  }

  /**
   * Add a directed edge between two nodes (constraining allowed transitions).
   */
  addEdge(from: string, to: string): this {
    if (!this.edges.has(from)) {
      this.edges.set(from, new Set());
    }
    this.edges.get(from)!.add(to);
    return this;
  }

  /**
   * Add multiple transition edges from a single node.
   */
  addEdges(from: string, toList: string[]): this {
    for (const to of toList) {
      this.addEdge(from, to);
    }
    return this;
  }

  /**
   * Set the initial entry point node.
   */
  setEntryPoint(nodeId: string): this {
    this.entryPoint = nodeId;
    return this;
  }

  /**
   * Custom embedding provider for JEV routing.
   */
  setEmbeddingProvider(provider: EmbeddingProvider): this {
    this.embeddingProvider = provider;
    return this;
  }

  /**
   * Set minimum confidence threshold.
   */
  setThreshold(threshold: number): this {
    this.confidenceThreshold = threshold;
    return this;
  }

  /**
   * Get raw graph data for inspection and visualization before or without compiling.
   */
  getGraph(): GraphData {
    const nodes = Array.from(this.nodes.entries()).map(([id, opt]) => ({
      id,
      description: opt.description,
      metadata: opt.metadata,
    }));

    const edges: Array<{ from: string; to: string }> = [];
    for (const [from, targetSet] of this.edges.entries()) {
      for (const to of targetSet) {
        edges.push({ from, to });
      }
    }

    return {
      nodes,
      edges,
      entryPoint: this.entryPoint,
    };
  }

  /**
   * Render an ASCII directed graph in the terminal.
   */
  drawAscii(options?: { title?: string }): string {
    return drawAscii(this.getGraph(), options);
  }

  /**
   * Export the graph structure as a Mermaid flowchart.
   */
  drawMermaid(): string {
    return drawMermaid(this.getGraph());
  }

  /**
   * Generate a direct Mermaid Live Editor link.
   */
  toMermaidLiveUrl(): string {
    return toMermaidLiveUrl(this.drawMermaid());
  }

  /**
   * Generate complete Markdown documentation for the graph.
   */
  drawMarkdown(options?: { title?: string }): string {
    return drawMarkdown(this.getGraph(), options);
  }

  /**
   * Visualize the graph in terminal (ASCII), as Markdown, or as an interactive HTML visualizer.
   */
  async visualize(options?: VisualizeOptions): Promise<VisualizeResult> {
    return visualizeGraph(this.getGraph(), options);
  }

  /**
   * Compile the VoiceGraph into an executable, stateful runtime.
   */
  async compile(): Promise<CompiledVoiceGraph<TState>> {
    if (this.nodes.size === 0) {
      throw new Error("VoiceGraph has no nodes. Call .addNode() before compiling.");
    }

    // Auto-resolve entry point if not set
    const entry = this.entryPoint || this.nodes.keys().next().value!;

    // Ensure fallback node exists
    if (!this.nodes.has("fallback")) {
      this.addNode("fallback", {
        description: "Out of scope queries, speech comments, weather, or unrecognized requests",
        run: "Sorry, I am not able to understand that. Could you please clarify?",
      });
    }

    // Initialize JEV Engine
    const embedding = this.embeddingProvider || new FastSemanticEmbeddingProvider();
    const jevEngine = new JEVEngine({
      embeddingProvider: embedding,
      confidenceThreshold: this.confidenceThreshold,
    });

    const agentActions: AgentAction[] = Array.from(this.nodes.entries()).map(([id, opt]) =>
      defineAction({
        id,
        description: `${id}: ${opt.description}`,
        handler: async () => (typeof opt.run === "string" ? opt.run : `Node ${id}`),
      })
    );

    await jevEngine.initialize(agentActions);

    return new CompiledVoiceGraph<TState>({
      nodes: this.nodes,
      edges: this.edges,
      entryPoint: entry,
      jevEngine,
      initialState: this.initialState,
    });
  }
}
