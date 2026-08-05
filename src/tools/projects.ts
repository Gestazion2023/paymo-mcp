import { z } from 'zod';
import type { PaymoRecord } from '../client.ts';
import { filterRecord, paginate } from '../fields.ts';
import { limit, offset, respond, verbose } from './shared.ts';
import type { ToolDef } from './shared.ts';

const projectId = z.number().int().describe('Paymo project id.');

const PROJECT_WRITE_FIELDS = [
  'name', 'code', 'client_id', 'description', 'budget_hours', 'billable',
] as const;

export const projectsTools: Record<string, ToolDef> = {
  paymo_get_project: {
    level: 'read',
    description: 'Fetch one Paymo project by id with its present state, to read before acting on it.',
    inputSchema: {
      project_id: projectId,
      verbose,
    },
    handler: (args: { project_id: number; verbose: boolean }, ctx) =>
      respond('get project', async () => {
        const record = await ctx.client.project(args.project_id);

        return filterRecord(record, 'project', args.verbose);
      }),
  },

  paymo_list_project_templates: {
    level: 'read',
    description: 'List Paymo project templates. Call this to resolve a template_id before creating a project from one.',
    inputSchema: { limit, offset, verbose },
    handler: (args: { limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list project templates', async () => {
        const records = await ctx.client.projectTemplates();
        const filtered = records.map((record) => filterRecord(record, 'projectTemplate', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_list_project_statuses: {
    level: 'read',
    description: 'List Paymo project statuses. Call this to resolve a status_id before setting one on a project.',
    inputSchema: { limit, offset, verbose },
    handler: (args: { limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list project statuses', async () => {
        const records = await ctx.client.projectStatuses();
        const filtered = records.map((record) => filterRecord(record, 'projectStatus', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_create_project: {
    level: 'write',
    description:
      'Create a Paymo project. Requires a name; optionally start from a template, which may copy '
      + 'the template\'s tasklists and tasks into the new project.',
    inputSchema: {
      name: z.string().max(255).describe('Project name.'),
      code: z.string().optional().describe('Short project code.'),
      client_id: z.number().int().optional().describe('Paymo client id.'),
      template_id: z
        .number()
        .int()
        .optional()
        .describe('Project template id from paymo_list_project_templates. May copy the template\'s tasklists and tasks.'),
      description: z.string().optional().describe('Project description.'),
      budget_hours: z.number().optional().describe('Budget in hours.'),
      billable: z.boolean().optional().describe('Whether time on this project is billed to the client.'),
    },
    handler: (args: {
      name: string;
      code?: string;
      client_id?: number;
      template_id?: number;
      description?: string;
      budget_hours?: number;
      billable?: boolean;
    }, ctx) => {
      const payload: PaymoRecord = { name: args.name };

      for (const key of PROJECT_WRITE_FIELDS) {
        const value = args[key];

        if (value !== undefined) {
          payload[key] = value;
        }
      }

      if (args.template_id !== undefined) {
        payload.template_id = args.template_id;
      }

      return respond('create project', () => ctx.client.createProject(payload));
    },
  },

  paymo_update_project: {
    level: 'write',
    description:
      'Update a Paymo project: any subset of the create fields, plus active and status_id. '
      + 'Archive a project by setting active to false — there is no separate archive tool.',
    inputSchema: {
      project_id: projectId,
      name: z.string().optional().describe('New name.'),
      code: z.string().optional().describe('New project code.'),
      client_id: z.number().int().optional().describe('Paymo client id.'),
      description: z.string().optional().describe('New description.'),
      budget_hours: z.number().optional().describe('Budget in hours.'),
      billable: z.boolean().optional().describe('Whether time on this project is billed to the client.'),
      active: z.boolean().optional().describe('Set false to archive the project (there is no separate archive tool).'),
      status_id: z.number().int().optional().describe('Project status id from paymo_list_project_statuses.'),
    },
    handler: (args: {
      project_id: number;
      name?: string;
      code?: string;
      client_id?: number;
      description?: string;
      budget_hours?: number;
      billable?: boolean;
      active?: boolean;
      status_id?: number;
    }, ctx) =>
      respond('update project', async () => {
        const payload: PaymoRecord = {};

        for (const key of [...PROJECT_WRITE_FIELDS, 'active', 'status_id'] as const) {
          const value = args[key];

          if (value !== undefined) {
            payload[key] = value;
          }
        }

        return ctx.client.updateProject(args.project_id, payload);
      }),
  },

  paymo_create_tasklist: {
    level: 'write',
    description: 'Create a tasklist (column) inside a project.',
    inputSchema: {
      project_id: projectId,
      name: z.string().max(255).describe('Tasklist (column) name.'),
      seq: z.number().int().optional().describe('Column order.'),
      milestone_id: z.number().int().optional().describe('Paymo milestone to assign this tasklist to.'),
    },
    handler: (args: {
      project_id: number;
      name: string;
      seq?: number;
      milestone_id?: number;
    }, ctx) => {
      const payload: PaymoRecord = { project_id: args.project_id, name: args.name };

      for (const key of ['seq', 'milestone_id'] as const) {
        const value = args[key];

        if (value !== undefined) {
          payload[key] = value;
        }
      }

      return respond('create tasklist', () => ctx.client.createTasklist(payload));
    },
  },

  paymo_update_tasklist: {
    level: 'write',
    description: 'Update a tasklist (column): rename, reorder with seq, reassign a milestone.',
    inputSchema: {
      tasklist_id: z.number().int().describe('Paymo tasklist id.'),
      name: z.string().optional().describe('New name.'),
      seq: z.number().int().optional().describe('New column order.'),
      milestone_id: z.number().int().optional().describe('Paymo milestone to assign this tasklist to.'),
    },
    handler: (args: {
      tasklist_id: number;
      name?: string;
      seq?: number;
      milestone_id?: number;
    }, ctx) =>
      respond('update tasklist', async () => {
        const payload: PaymoRecord = {};

        for (const key of ['name', 'seq', 'milestone_id'] as const) {
          const value = args[key];

          if (value !== undefined) {
            payload[key] = value;
          }
        }

        return ctx.client.updateTasklist(args.tasklist_id, payload);
      }),
  },
};
