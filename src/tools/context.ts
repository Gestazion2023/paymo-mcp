import type { PaymoRecord } from '../client.ts';
import { filterRecord, paginate } from '../fields.ts';
import { limit, offset, respond, verbose } from './shared.ts';
import type { ToolDef } from './shared.ts';

export const contextTools: Record<string, ToolDef> = {
  paymo_me: {
    level: 'read',
    description:
      'Returns the authenticated Paymo user (id, name, email, timezone, workflows, assigned projects).',
    inputSchema: { verbose },
    handler: (args: { verbose: boolean }, ctx) =>
      respond('get me', async () => {
        const payload = await ctx.client.me();
        const user = (payload.users as PaymoRecord[] | undefined)?.[0] ?? null;

        return user === null ? null : filterRecord(user, 'user', args.verbose);
      }),
  },

  paymo_list_workflow_statuses: {
    level: 'read',
    description:
      'List the workflow statuses available in Paymo (id, name, seq, action) — useful to map status_id to a human name.',
    inputSchema: { limit, offset, verbose },
    handler: (args: { limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('workflow statuses', async () => {
        const records = await ctx.client.workflowStatuses();
        const filtered = records.map((record) => filterRecord(record, 'workflowstatus', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },
};