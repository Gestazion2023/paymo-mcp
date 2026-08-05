import { z } from 'zod';
import { filterRecord } from '../fields.ts';
import { respond, taskIdentifier, verbose } from './shared.ts';
import type { ToolDef } from './shared.ts';

export const timeTools: Record<string, ToolDef> = {
  paymo_timer_status: {
    level: 'read',
    description:
      "Returns the running Paymo time entry for the authenticated user, or null if no timer is active.",
    inputSchema: { verbose },
    handler: (args: { verbose: boolean }, ctx) =>
      respond('timer status', async () => {
        const userId = await ctx.client.currentUserId();
        const entry = await ctx.client.runningEntry(userId);

        return {
          running: entry === null ? null : filterRecord(entry, 'entry', args.verbose),
        };
      }),
  },

  paymo_start_timer: {
    level: 'write',
    description:
      'Start a running Paymo time entry on a task. Any running timer for the user is closed first to avoid concurrency.',
    inputSchema: { task: taskIdentifier },
    handler: (args: { task: string }, ctx) =>
      respond('start timer', async () => {
        const userId = await ctx.client.currentUserId();
        const running = await ctx.client.runningEntry(userId);
        const previousClosed = typeof running?.id === 'number'
          ? await ctx.client.stopEntry(running.id)
          : null;

        const taskId = await ctx.client.resolveTaskId(args.task);
        const entry = await ctx.client.startEntry(taskId);

        return { started: entry, previous_closed: previousClosed };
      }),
  },

  paymo_delete_entry: {
    level: 'delete',
    description:
      'Delete a Paymo time entry by id. Needed to discard a timer that ran for less than a '
      + 'minute: Paymo refuses to set an end_time that would make the entry shorter than that, '
      + 'so such a timer can only be closed by deleting it. Use paymo_timer_status to get the id.',
    inputSchema: {
      entry_id: z.number().int().describe('Numeric id of the time entry to delete.'),
    },
    handler: (args: { entry_id: number }, ctx) =>
      respond('delete entry', async () => {
        await ctx.client.deleteEntry(args.entry_id);

        return { deleted: args.entry_id };
      }),
  },

  paymo_stop_timer: {
    level: 'write',
    description:
      'Stop the running Paymo time entry of the authenticated user. No-op if none is active. '
      + 'If the entry is under a minute old Paymo may refuse the stop; delete it with '
      + 'paymo_delete_entry instead.',
    handler: (_args: {}, ctx) =>
      respond('stop timer', async () => {
        const userId = await ctx.client.currentUserId();
        const running = await ctx.client.runningEntry(userId);

        if (running === null || typeof running.id !== 'number') {
          return { stopped: null, message: 'No running timer for the current user.' };
        }

        return { stopped: await ctx.client.stopEntry(running.id) };
      }),
  },
};