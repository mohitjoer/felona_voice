import type { AgentTool, ToolExecutor } from "../types.js";

/**
 * ToolRegistry — Manages tool registration and execution.
 *
 * Tools are external capabilities the agent can invoke during a call
 * (e.g., booking appointments, looking up orders, transferring calls).
 */
export class ToolRegistry implements ToolExecutor {
  private tools: Map<string, AgentTool> = new Map();

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

    try {
      const result = await tool.execute(params ?? {});
      return result;
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
