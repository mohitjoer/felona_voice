import type { AgentTool, ToolExecutor } from "../types.js";
import { SPAN, type FelonaTracer } from "../observability/tracing.js";

/**
 * ToolRegistry — Manages tool registration and execution.
 *
 * Tools are external capabilities the agent can invoke during a call
 * (e.g., booking appointments, looking up orders, transferring calls).
 */
export class ToolRegistry implements ToolExecutor {
  private tools: Map<string, AgentTool> = new Map();
  /**
   * Optional instrumentation. A registry created by the pipeline inherits the
   * agent's tracer so a tool call nests under the turn that triggered it.
   */
  private tracer: FelonaTracer | null = null;

  /** Trace tool calls. Pass `null` to stop tracing them. */
  setTracer(tracer: FelonaTracer | null): void {
    this.tracer = tracer;
  }

  /** Register a tool */
  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tools at once */
  registerAll(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Call a registered tool by name */
  async call(
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(
        `Tool "${toolName}" not found. Available: ${[...this.tools.keys()].join(", ")}`,
      );
    }

    // A tool is the step most likely to leave the process, so it gets the most
    // careful attributes: the tool name and the shape of the arguments, never
    // the argument values, which routinely hold whatever the caller said.
    const spanAttrs = {
      "felona.tool.name": toolName,
      "felona.tool.arg_keys": Object.keys(params ?? {}).join(","),
    };

    if (!this.tracer) return this.invoke(toolName, tool, params);

    return this.tracer.span(SPAN.toolCall, spanAttrs, async (span) => {
      try {
        const result = await this.invoke(toolName, tool, params);
        span.setAttribute("felona.tool.ok", true);
        return result;
      } catch (error) {
        span.setAttribute("felona.tool.ok", false);
        throw error;
      }
    });
  }

  private async invoke(
    toolName: string,
    tool: AgentTool,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await tool.execute(params ?? {});
    } catch (error) {
      throw new Error(
        `Tool "${toolName}" execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** List all registered tools */
  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  /** Check if a tool is registered */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /** Get a tool's schema (for LLM function calling) */
  getSchema(
    toolName: string,
  ): { name: string; description: string; parameters: Record<string, unknown> } | undefined {
    const tool = this.tools.get(toolName);
    if (!tool) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  /** Get all tool schemas (for LLM function calling) */
  getAllSchemas(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

/**
 * Helper to define a tool with type safety.
 */
export function defineTool(tool: AgentTool): AgentTool {
  return tool;
}

export function createToolRegistry(tools?: AgentTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  if (tools) {
    registry.registerAll(tools);
  }
  return registry;
}
