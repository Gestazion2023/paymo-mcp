import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { contextTools } from './context.ts';
import { tasksTools } from './tasks.ts';
import { timeTools } from './time.ts';
import type { ToolDef, ToolsContext } from './shared.ts';

export type { ToolsContext } from './shared.ts';
export { respond } from './shared.ts';

/**
 * Every tool, defined exactly once. A tool referenced by two toolsets is not a duplicate to
 * reconcile — it is one entry referenced twice. `TOOLSETS` is populated now but not yet read;
 * the resolution rules land with the configuration work.
 */
export const TOOLS: Record<string, ToolDef> = {
  ...contextTools,
  ...tasksTools,
  ...timeTools,
};

export const TOOLSETS: Record<string, string[]> = {
  context: ['paymo_me', 'paymo_list_workflow_statuses'],
  tasks: [
    'paymo_list_projects', 'paymo_list_tasklists', 'paymo_list_tasks', 'paymo_get_task',
    'paymo_create_task', 'paymo_update_task', 'paymo_add_comment',
  ],
  time: ['paymo_timer_status', 'paymo_start_timer', 'paymo_stop_timer', 'paymo_delete_entry'],
};

export function registerTools(server: McpServer, ctx: ToolsContext): void {
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (ctx.readOnly && tool.level !== 'read') {
      continue;
    }

    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => tool.handler(args as never, ctx),
    );
  }
}
