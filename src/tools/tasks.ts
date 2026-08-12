import { z } from 'zod';
import type { PaymoRecord } from '../client.ts';
import { filterRecord, paginate } from '../fields.ts';
import {
  limit,
  offset,
  PRIORITY,
  projectId,
  respond,
  RICH_TEXT,
  statusArg,
  taskIdentifier,
  verbose,
} from './shared.ts';
import type { ToolDef } from './shared.ts';

export const tasksTools: Record<string, ToolDef> = {
  paymo_list_projects: {
    level: 'read',
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
    handler: (args: { active: boolean; limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list projects', async () => {
        const records = await ctx.client.projects(args.active);
        const filtered = records.map((record) => filterRecord(record, 'projectSummary', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_list_tasklists: {
    level: 'read',
    description: 'List tasklists (columns) for a project, or across all tasks when unset.',
    inputSchema: {
      project_id: z.number().int().optional().describe('Restrict to a single project.'),
      limit,
      offset,
      verbose,
    },
    handler: (args: { project_id?: number; limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list tasklists', async () => {
        const records = await ctx.client.tasklists(args.project_id ?? null);
        const filtered = records.map((record) => filterRecord(record, 'tasklist', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_list_tasks: {
    level: 'read',
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
    handler: (
      args: { project_id?: number; include_completed: boolean; limit: number; offset: number; verbose: boolean },
      ctx,
    ) =>
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
  },

  paymo_get_task: {
    level: 'read',
    description: 'Fetch a Paymo task by numeric id or human code.',
    inputSchema: { task: taskIdentifier, verbose },
    handler: (args: { task: string; verbose: boolean }, ctx) =>
      respond('get task', async () => {
        const id = await ctx.client.resolveTaskId(args.task);
        const task = await ctx.client.task(id);

        return filterRecord(task, 'task', args.verbose);
      }),
  },

  paymo_list_comments: {
    level: 'read',
    description:
      'Read the comment thread of a Paymo task, oldest first. Call it to catch up on the '
      + 'discussion before answering with paymo_add_comment.',
    inputSchema: {
      task: taskIdentifier,
      limit,
      offset,
      verbose,
    },
    handler: (args: { task: string; limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list comments', async () => {
        const id = await ctx.client.resolveTaskId(args.task);
        const records = await ctx.client.comments(id);
        // A conversation reads oldest first, and Paymo documents no ordering on /comments, so the
        // order is imposed here rather than trusted. `created_on` is the ISO timestamp Paymo
        // returns, comparable as a string; the id breaks ties within the same second.
        const ordered = [...records].sort((a, b) => {
          const written = String(a.created_on ?? '').localeCompare(String(b.created_on ?? ''));

          return written === 0 ? Number(a.id ?? 0) - Number(b.id ?? 0) : written;
        });
        const filtered = ordered.map((record) => filterRecord(record, 'comment', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_create_task: {
    level: 'write',
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
    handler: (
      args: {
        name: string;
        project_id?: number;
        tasklist_id?: number;
        description?: string;
        due_date?: string;
        priority?: number;
        users?: number[];
      },
      ctx,
    ) => {
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

      return respond('create task', () => ctx.client.createTask(payload));
    },
  },

  paymo_update_task: {
    level: 'write',
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
    handler: (
      args: {
        task: string;
        name?: string;
        description?: string;
        due_date?: string;
        priority?: number;
        users?: number[];
        complete?: boolean;
        status?: string;
      },
      ctx,
    ) =>
      respond('update task', async () => {
        const id = await ctx.client.resolveTaskId(args.task);
        const payload: PaymoRecord = {};

        for (const key of ['name', 'description', 'due_date', 'priority', 'users', 'complete'] as const) {
          const value = args[key];

          if (value !== undefined) {
            payload[key] = value;
          }
        }

        if (args.status !== undefined) {
          payload.status_id = await ctx.resolver.resolve(args.status, () => ctx.client.workflowStatuses());
        }

        return ctx.client.updateTask(id, payload);
      }),
  },

  paymo_add_comment: {
    level: 'write',
    description: 'Add a comment to a Paymo task.',
    inputSchema: {
      task: taskIdentifier,
      content: z.string().describe(`Comment text. ${RICH_TEXT}`),
    },
    handler: (args: { task: string; content: string }, ctx) =>
      respond('add comment', async () => {
        const id = await ctx.client.resolveTaskId(args.task);
        return ctx.client.addComment(id, args.content);
      }),
  },

  paymo_update_comment: {
    level: 'write',
    description:
      'Rewrite an existing Paymo comment, replacing its whole body. There is no delete tool for '
      + 'comments, so this is the only way to correct one — get the comment_id from '
      + 'paymo_list_comments.',
    inputSchema: {
      comment_id: z.number().int().describe('Paymo comment id, as returned by paymo_list_comments.'),
      content: z.string().describe(`New comment text, replacing the previous body. ${RICH_TEXT}`),
    },
    handler: (args: { comment_id: number; content: string }, ctx) =>
      respond('update comment', () => ctx.client.updateComment(args.comment_id, args.content)),
  },
};