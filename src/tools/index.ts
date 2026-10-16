import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigError } from '../config.ts';
import type { PermissionMode } from '../config.ts';
import { billingTools } from './billing.ts';
import { clientsTools } from './clients.ts';
import { contextTools } from './context.ts';
import { projectsTools } from './projects.ts';
import { tasksTools } from './tasks.ts';
import { timeTools } from './time.ts';
import type { ToolDef, ToolsContext } from './shared.ts';

export type { ToolsContext } from './shared.ts';
export { respond } from './shared.ts';

/**
 * Every tool, defined exactly once. A tool referenced by two toolsets is not a duplicate to
 * reconcile — it is one entry referenced twice. A toolset is just a list of names into `TOOLS`.
 */
export const TOOLS: Record<string, ToolDef> = {
  ...billingTools,
  ...clientsTools,
  ...contextTools,
  ...projectsTools,
  ...tasksTools,
  ...timeTools,
};

export const TOOLSETS: Record<string, string[]> = {
  context: ['paymo_me', 'paymo_list_workflow_statuses'],
  tasks: [
    'paymo_list_projects', 'paymo_list_tasklists', 'paymo_list_tasks', 'paymo_get_task',
    'paymo_list_comments', 'paymo_list_users',
    'paymo_create_task', 'paymo_update_task', 'paymo_add_comment', 'paymo_update_comment',
    'paymo_upload_file',
  ],
  time: ['paymo_timer_status', 'paymo_start_timer', 'paymo_stop_timer', 'paymo_delete_entry'],
  projects: [
    'paymo_list_projects', 'paymo_list_tasklists',
    'paymo_get_project', 'paymo_list_project_templates', 'paymo_list_project_statuses',
    'paymo_create_project', 'paymo_update_project', 'paymo_create_tasklist', 'paymo_update_tasklist',
  ],
  clients: [
    'paymo_list_clients', 'paymo_get_client', 'paymo_list_client_contacts', 'paymo_get_company',
    'paymo_create_client', 'paymo_update_client',
    'paymo_create_client_contact', 'paymo_update_client_contact',
  ],
  billing: [
    'paymo_list_invoices', 'paymo_get_invoice', 'paymo_list_invoice_payments',
    'paymo_list_estimates', 'paymo_get_estimate', 'paymo_list_invoice_templates',
  ],
};

/** Roughly v0.1.0's surface, so an existing user upgrading sees no change. */
export const DEFAULT_TOOLSETS = ['context', 'tasks', 'time'];

/**
 * Resolves the configuration into the set of tools to register, in this order:
 *
 *   1. expand `toolsets` (empty → defaults; `default` keyword; `all` keyword)
 *   2. union `tools` (PAYMO_TOOLS, additive, matched exactly as registered)
 *   3. subtract `deniedToolsRegex` (PAYMO_DENIED_TOOLS_REGEX)
 *   4. filter by permission mode — always last, never overridable by naming a tool
 *
 * Unknown names abort, listing the valid values, and a selection that resolves to no tools is a
 * startup error: a server with zero tools is indistinguishable from a broken one.
 */
export function resolveTools(config: {
  toolsets: string[];
  tools: string[];
  deniedToolsRegex: RegExp | null;
  permissionMode: PermissionMode;
}): Set<string> {
  const names = new Set<string>();

  const toolsetNames = config.toolsets.length === 0 ? ['default'] : config.toolsets;

  for (const raw of toolsetNames) {
    const name = raw.toLowerCase().trim();

    if (name === 'all') {
      for (const members of Object.values(TOOLSETS)) {
        for (const member of members) {
          names.add(member);
        }
      }
    } else if (name === 'default') {
      for (const set of DEFAULT_TOOLSETS) {
        for (const member of TOOLSETS[set] ?? []) {
          names.add(member);
        }
      }
    } else if (name in TOOLSETS) {
      for (const member of TOOLSETS[name]!) {
        names.add(member);
      }
    } else {
      throw new ConfigError(
        `Unknown toolset '${raw}'. Valid toolsets: ${[...Object.keys(TOOLSETS), 'default', 'all'].join(', ')}.`,
      );
    }
  }

  for (const tool of config.tools) {
    if (TOOLS[tool] === undefined) {
      throw new ConfigError(`Unknown tool '${tool}'. Valid tools: ${Object.keys(TOOLS).join(', ')}.`);
    }

    names.add(tool);
  }

  if (config.deniedToolsRegex !== null) {
    for (const name of [...names]) {
      if (config.deniedToolsRegex.test(name)) {
        names.delete(name);
      }
    }
  }

  const registered = new Set<string>();

  for (const name of names) {
    const tool = TOOLS[name];

    if (tool === undefined) {
      continue;
    }

    if (config.permissionMode === 'readonly' && tool.level !== 'read') {
      continue;
    }

    if (config.permissionMode === 'modify' && tool.level === 'delete') {
      continue;
    }

    registered.add(name);
  }

  if (registered.size === 0) {
    throw new ConfigError(
      'The tool selection resolved to no tools. Check PAYMO_TOOLSETS, PAYMO_TOOLS and '
        + 'PAYMO_DENIED_TOOLS_REGEX; the server cannot run without at least one tool.',
    );
  }

  return registered;
}

export function registerTools(server: McpServer, ctx: ToolsContext): void {
  const registered = new Set<string>();

  for (const name of ctx.registeredTools) {
    const tool = TOOLS[name];

    if (tool === undefined) {
      continue;
    }

    if (ctx.permissionMode === 'readonly' && tool.level !== 'read') {
      continue;
    }

    if (ctx.permissionMode === 'modify' && tool.level === 'delete') {
      continue;
    }

    registered.add(name);
  }

  const handlerCtx: ToolsContext = { ...ctx, registeredTools: registered };

  for (const name of registered) {
    const tool = TOOLS[name];

    if (tool === undefined) {
      continue;
    }

    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => tool.handler(args as never, handlerCtx),
    );
  }
}
