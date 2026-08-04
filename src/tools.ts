import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PaymoClient, PaymoRecord } from './client.ts';
import { StatusResolver } from './statuses.ts';

export interface ToolsContext {
  client: PaymoClient;
  resolver: StatusResolver;
  defaultProjectId: number | null;
  readOnly: boolean;
}

const taskIdentifier = z
  .string()
  .describe('Numeric task id (e.g. 1234) or human task code (e.g. ABC-1).');
const projectId = z
  .number()
  .int()
  .describe('Paymo project id. When omitted, the configured default is used.');
const statusArg = z
  .string()
  .describe('Numeric workflow status id or a slug alias (e.g. in_progress).');

export async function respond(context: string, fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return {
      content: [{ type: 'text', text: `Paymo ${context} failed: ${message}` }],
      isError: true,
    };
  }
}

export function registerTools(server: McpServer, ctx: ToolsContext): void {
  server.registerTool(
    'paymo_me',
    {
      description:
        'Returns the authenticated Paymo user (id, name, email, timezone, workflows, assigned projects).',
    },
    () => respond('get me', async () => {
      const payload = await ctx.client.me();
      return (payload.users as PaymoRecord[] | undefined)?.[0] ?? [];
    }),
  );

  server.registerTool(
    'paymo_list_projects',
    {
      description: 'List Paymo projects the user has access to.',
      inputSchema: {
        active: z
          .boolean()
          .default(true)
          .describe('When true (default) only active projects are returned.'),
      },
    },
    (args) => respond('list projects', () => ctx.client.projects(args.active)),
  );

  server.registerTool(
    'paymo_list_tasklists',
    {
      description: 'List tasklists (columns) for a project, or across all tasks when unset.',
      inputSchema: {
        project_id: z.number().int().optional().describe('Restrict to a single project.'),
      },
    },
    (args) => respond('list tasklists', () => ctx.client.tasklists(args.project_id ?? null)),
  );

  server.registerTool(
    'paymo_list_tasks',
    {
      description: 'List tasks, defaults to incomplete tasks of the configured project.',
      inputSchema: {
        project_id: projectId.optional(),
        include_completed: z
          .boolean()
          .default(false)
          .describe('When true, include completed tasks. Defaults to false.'),
      },
    },
    (args) =>
      respond('list tasks', async () => {
        let targetProjectId = args.project_id;

        if (targetProjectId === undefined) {
          if (ctx.defaultProjectId === null) {
            throw new Error(
              'No project_id given and no PAYMO_DEFAULT_PROJECT_ID configured. Run paymo_list_projects to pick one.',
            );
          }

          targetProjectId = ctx.defaultProjectId;
        }

        return ctx.client.tasks(targetProjectId, !args.include_completed);
      }),
  );

  server.registerTool(
    'paymo_get_task',
    {
      description: 'Fetch a Paymo task by numeric id or human code.',
      inputSchema: { task: taskIdentifier },
    },
    (args) =>
      respond('get task', async () => {
        const id = await ctx.client.resolveTaskId(args.task);
        return ctx.client.task(id);
      }),
  );

  server.registerTool(
    'paymo_list_workflow_statuses',
    {
      description:
        'List the workflow statuses available in Paymo (id, name, seq, action) — useful to map status_id to a human name.',
    },
    () => respond('workflow statuses', () => ctx.client.workflowStatuses()),
  );

  server.registerTool(
    'paymo_timer_status',
    {
      description:
        "Returns the running Paymo time entry for the authenticated user, or null if no timer is active.",
    },
    () =>
      respond('timer status', async () => {
        const userId = await ctx.client.currentUserId();
        const entry = await ctx.client.runningEntry(userId);

        return { running: entry };
      }),
  );

  if (!ctx.readOnly) {
    registerWriteTools(server, ctx);
  }
}

function registerWriteTools(server: McpServer, c: ToolsContext): void {
  server.registerTool(
    'paymo_create_task',
    {
      description:
        'Create a new Paymo task. Requires a name and either a project_id or a tasklist_id. Optional: description, due_date (YYYY-MM-DD), priority (50 normal), users (list of user ids).',
      inputSchema: {
        name: z.string().max(255).describe('Task title.'),
        project_id: z.number().int().optional().describe('Required if tasklist_id is not given.'),
        tasklist_id: z
          .number()
          .int()
          .optional()
          .describe('Paymo tasklist (column) id. Required if project_id is not given.'),
        description: z.string().optional().describe('Optional task description (HTML allowed).'),
        due_date: z.string().optional().describe('Optional due date in YYYY-MM-DD format.'),
        priority: z.number().int().optional().describe('Optional priority (50 = normal).'),
        users: z.array(z.number().int()).optional().describe('Optional assignees (Paymo user ids).'),
      },
    },
    (args) => {
      if (args.project_id === undefined && args.tasklist_id === undefined) {
        return {
          content: [{ type: 'text', text: 'Either project_id or tasklist_id is required.' }],
          isError: true,
        };
      }

      const payload: PaymoRecord = { name: args.name };

      for (const key of ['project_id', 'tasklist_id', 'description', 'due_date', 'priority', 'users'] as const) {
        const value = args[key];

        if (value !== undefined) {
          payload[key] = value;
        }
      }

      return respond('create task', () => c.client.createTask(payload));
    },
  );

  server.registerTool(
    'paymo_update_task',
    {
      description:
        'Update a Paymo task. status accepts a numeric id or a slug alias (e.g. in_progress); complete toggles completion.',
      inputSchema: {
        task: taskIdentifier,
        name: z.string().optional().describe('New title.'),
        description: z.string().optional().describe('New description (HTML allowed).'),
        due_date: z.string().optional().describe('Due date in YYYY-MM-DD format.'),
        priority: z.number().int().optional().describe('Priority (50 = normal).'),
        users: z.array(z.number().int()).optional().describe('Assignees (Paymo user ids).'),
        complete: z.boolean().optional().describe('Mark complete (true) or reopen (false).'),
        status: statusArg.optional().describe('Workflow status id or alias.'),
      },
    },
    (args) =>
      respond('update task', async () => {
        const id = await c.client.resolveTaskId(args.task);
        const payload: PaymoRecord = {};

        for (const key of ['name', 'description', 'due_date', 'priority', 'users', 'complete'] as const) {
          const value = args[key];

          if (value !== undefined) {
            payload[key] = value;
          }
        }

        if (args.status !== undefined) {
          payload.status_id = await c.resolver.resolve(args.status, () => c.client.workflowStatuses());
        }

        return c.client.updateTask(id, payload);
      }),
  );

  server.registerTool(
    'paymo_add_comment',
    {
      description: 'Add a comment to a Paymo task.',
      inputSchema: {
        task: taskIdentifier,
        content: z.string().describe('Comment text (HTML allowed).'),
      },
    },
    (args) =>
      respond('add comment', async () => {
        const id = await c.client.resolveTaskId(args.task);
        return c.client.addComment(id, args.content);
      }),
  );

  server.registerTool(
    'paymo_start_timer',
    {
      description:
        'Start a running Paymo time entry on a task. Any running timer for the user is closed first to avoid concurrency.',
      inputSchema: { task: taskIdentifier },
    },
    (args) =>
      respond('start timer', async () => {
        const userId = await c.client.currentUserId();
        const previous = await c.client.runningEntry(userId);

        if (typeof previous?.id === 'number') {
          await c.client.stopEntry(previous.id);
        }

        const taskId = await c.client.resolveTaskId(args.task);
        const entry = await c.client.startEntry(taskId);

        return { started: entry, previous_closed: previous };
      }),
  );

  server.registerTool(
    'paymo_stop_timer',
    {
      description: 'Stop the running Paymo time entry of the authenticated user. No-op if none is active.',
    },
    () =>
      respond('stop timer', async () => {
        const userId = await c.client.currentUserId();
        const running = await c.client.runningEntry(userId);

        if (running === null || typeof running.id !== 'number') {
          return { stopped: null, message: 'No running timer for the current user.' };
        }

        return { stopped: await c.client.stopEntry(running.id) };
      }),
  );
}