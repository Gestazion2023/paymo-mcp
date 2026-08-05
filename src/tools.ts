import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PaymoClient, PaymoRecord } from './client.ts';
import { filterRecord, paginate } from './fields.ts';
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

const PRIORITY = 'Priority: 100 critical, 75 high, 50 normal, 25 low. Paymo only uses these four.';

const RICH_TEXT =
  'Paymo renders HTML here (p, b, i, u, s, ul, ol, li, h2, blockquote, a, br, code, pre, span) '
  + 'and strips anything else. Markdown is not rendered: use tags, not ** or backticks.';

/**
 * Bounded by default: a 90-task project answers with ~19 kB even after field filtering, and once
 * that lands in the conversation it is re-sent on every later turn. Raise it explicitly when you
 * genuinely need more, and page with `offset`.
 */
const limit = z
  .number()
  .int()
  .min(1)
  .default(50)
  .describe(
    'Maximum number of records to return (default 50). Raise it when you need more, and use '
    + 'offset to page. Large listings are expensive: they stay in context for the rest of the '
    + 'conversation.',
  );
const offset = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Number of records to skip before returning, for paging past the first page.');
const verbose = z
  .boolean()
  .default(false)
  .describe(
    'When false (default) only the documented field subset is returned. Set true to return '
    + 'every field Paymo provides for each record.',
  );

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
      inputSchema: { verbose },
    },
    (args) => respond('get me', async () => {
      const payload = await ctx.client.me();
      const user = (payload.users as PaymoRecord[] | undefined)?.[0] ?? null;

      return user === null ? null : filterRecord(user, 'user', args.verbose);
    }),
  );

  server.registerTool(
    'paymo_list_projects',
    {
      description: 'List Paymo projects the user has access to, with the documented field subset.',
      inputSchema: {
        active: z
          .boolean()
          .default(true)
          .describe('When true (default) only active projects are returned.'),
        limit,
        offset,
        verbose,
      },
    },
    (args) => respond('list projects', async () => {
      const records = await ctx.client.projects(args.active);
      const filtered = records.map((record) => filterRecord(record, 'projectSummary', args.verbose));

      return paginate(filtered, args.limit, args.offset);
    }),
  );

  server.registerTool(
    'paymo_list_tasklists',
    {
      description: 'List tasklists (columns) for a project, or across all tasks when unset.',
      inputSchema: {
        project_id: z.number().int().optional().describe('Restrict to a single project.'),
        limit,
        offset,
        verbose,
      },
    },
    (args) => respond('list tasklists', async () => {
      const records = await ctx.client.tasklists(args.project_id ?? null);
      const filtered = records.map((record) => filterRecord(record, 'tasklist', args.verbose));

      return paginate(filtered, args.limit, args.offset);
    }),
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
        limit,
        offset,
        verbose,
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

        const records = await ctx.client.tasks(targetProjectId, !args.include_completed);
        const filtered = records.map((record) => filterRecord(record, 'taskSummary', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  );

  server.registerTool(
    'paymo_get_task',
    {
      description: 'Fetch a Paymo task by numeric id or human code.',
      inputSchema: { task: taskIdentifier, verbose },
    },
    (args) =>
      respond('get task', async () => {
        const id = await ctx.client.resolveTaskId(args.task);
        const task = await ctx.client.task(id);

        return filterRecord(task, 'task', args.verbose);
      }),
  );

  server.registerTool(
    'paymo_list_workflow_statuses',
    {
      description:
        'List the workflow statuses available in Paymo (id, name, seq, action) — useful to map status_id to a human name.',
      inputSchema: { limit, offset, verbose },
    },
    (args) => respond('workflow statuses', async () => {
      const records = await ctx.client.workflowStatuses();
      const filtered = records.map((record) => filterRecord(record, 'workflowstatus', args.verbose));

      return paginate(filtered, args.limit, args.offset);
    }),
  );

  server.registerTool(
    'paymo_timer_status',
    {
      description:
        "Returns the running Paymo time entry for the authenticated user, or null if no timer is active.",
      inputSchema: { verbose },
    },
    (args) =>
      respond('timer status', async () => {
        const userId = await ctx.client.currentUserId();
        const entry = await ctx.client.runningEntry(userId);

        return {
          running: entry === null ? null : filterRecord(entry, 'entry', args.verbose),
        };
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
        'Create a new Paymo task. Requires a name and either a project_id or a tasklist_id. Optional: description, due_date (YYYY-MM-DD), priority (100/75/50/25), users (list of user ids).',
      inputSchema: {
        name: z.string().max(255).describe('Task title.'),
        project_id: z.number().int().optional().describe('Required if tasklist_id is not given.'),
        tasklist_id: z
          .number()
          .int()
          .optional()
          .describe('Paymo tasklist (column) id. Required if project_id is not given.'),
        description: z
          .string()
          .optional()
          .describe(`Optional task description. ${RICH_TEXT}`),
        due_date: z.string().optional().describe('Optional due date in YYYY-MM-DD format.'),
        priority: z.number().int().optional().describe(`Optional ${PRIORITY}`),
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
        'Update a Paymo task. status accepts a numeric id or a slug alias (e.g. in_progress). '
        + 'Do not send complete and status together: Paymo forces the status to Complete when '
        + 'completing and to Backlog when reopening, so the status argument would be overwritten.',
      inputSchema: {
        task: taskIdentifier,
        name: z.string().optional().describe('New title.'),
        description: z.string().optional().describe(`New description. ${RICH_TEXT}`),
        due_date: z.string().optional().describe('Due date in YYYY-MM-DD format.'),
        priority: z.number().int().optional().describe(`${PRIORITY}`),
        users: z.array(z.number().int()).optional().describe('Assignees (Paymo user ids).'),
        complete: z.boolean().optional().describe('Mark complete (true) or reopen (false). Also resets status, so do not pass status too.'),
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
        content: z.string().describe(`Comment text. ${RICH_TEXT}`),
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
        const running = await c.client.runningEntry(userId);
        const previousClosed = typeof running?.id === 'number'
          ? await c.client.stopEntry(running.id)
          : null;

        const taskId = await c.client.resolveTaskId(args.task);
        const entry = await c.client.startEntry(taskId);

        return { started: entry, previous_closed: previousClosed };
      }),
  );

  server.registerTool(
    'paymo_delete_entry',
    {
      description:
        'Delete a Paymo time entry by id. Needed to discard a timer that ran for less than a '
        + 'minute: Paymo refuses to set an end_time that would make the entry shorter than that, '
        + 'so such a timer can only be closed by deleting it. Use paymo_timer_status to get the id.',
      inputSchema: {
        entry_id: z.number().int().describe('Numeric id of the time entry to delete.'),
      },
    },
    (args) =>
      respond('delete entry', async () => {
        await c.client.deleteEntry(args.entry_id);

        return { deleted: args.entry_id };
      }),
  );

  server.registerTool(
    'paymo_stop_timer',
    {
      description:
        'Stop the running Paymo time entry of the authenticated user. No-op if none is active. '
        + 'If the entry is under a minute old Paymo may refuse the stop; delete it with '
        + 'paymo_delete_entry instead.',
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