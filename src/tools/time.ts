import { z } from 'zod';
import type { PaymoRecord } from '../client.ts';
import { filterRecord } from '../fields.ts';
import { respond, taskIdentifier, verbose } from './shared.ts';
import type { ToolDef } from './shared.ts';

/**
 * Paymo refuses to set an `end_time` that would make an entry shorter than a minute, so a timer
 * under a minute old can only be closed by deleting it. True when the entry started less than a
 * minute ago, which is the case the API rejects.
 */
function isSubMinute(entry: PaymoRecord): boolean {
  const start = entry.start_time;

  if (typeof start !== 'string') {
    return false;
  }

  const startedAt = Date.parse(start);

  return !Number.isNaN(startedAt) && Date.now() - startedAt < 60_000;
}

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

        try {
          return { stopped: await ctx.client.stopEntry(running.id) };
        } catch (err) {
          // The default `modify` mode drops paymo_delete_entry, so a caller that hits the
          // sub-minute rejection under the default configuration walks into a dead end unless the
          // error names the way out and the mode that provides it.
          if (isSubMinute(running) && !ctx.registeredTools.has('paymo_delete_entry')) {
            throw new Error(
              'Paymo refuses to stop an entry under a minute old. Delete it with paymo_delete_entry, '
              + 'which requires PAYMO_PERMISSION_MODE=full.',
            );
          }

          throw err;
        }
      }),
  },
};