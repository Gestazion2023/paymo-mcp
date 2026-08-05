import type { PaymoRecord } from './client.ts';

/**
 * Documented field subsets for the list and detail tools. An agent needs an id, a name and a
 * code, not flat_billing or cover_file_id; Paymo answers with 20-40 fields per record and a
 * listing lands in the conversation verbatim, so dropping the noise is the biggest token win in
 * the package. Field names verified against the live API.
 */
export type RecordKind =
  | 'user'
  | 'project'
  | 'projectSummary'
  | 'task'
  | 'taskSummary'
  | 'tasklist'
  | 'workflowstatus'
  | 'entry';

export const SUBSETS: Record<RecordKind, readonly string[]> = {
  user: [
    'id', 'name', 'email', 'type', 'active', 'timezone', 'position', 'language',
    'workday_hours', 'created_on', 'updated_on',
  ],
  project: [
    'id', 'name', 'code', 'description', 'client_id', 'client_name', 'workflow_id',
    'status_id', 'active', 'seq', 'created_on', 'updated_on',
  ],
  // A listing exists to pick a record, a detail read to act on it. `projectSummary` is what a
  // caller needs to choose; the detail `project` subset above adds what acting needs.
  projectSummary: ['id', 'name', 'code', 'active', 'client_id', 'client_name'],
  // `users` is load-bearing, not informational: paymo_update_task replaces the assignee list
  // wholesale, so a caller that cannot see the current assignees will silently drop them when
  // adding one. Never remove it from this subset.
  task: [
    'id', 'name', 'code', 'project_id', 'tasklist_id', 'user_id', 'users', 'complete', 'status_id',
    'priority', 'due_date', 'start_date', 'description', 'seq', 'created_on', 'updated_on',
  ],
  // Same split as projects: a listing is for picking. `users` stays here for the same reason it
  // stays in `task` — dropping it recreates the assignee data-loss bug.
  taskSummary: [
    'id', 'name', 'code', 'project_id', 'tasklist_id', 'users', 'complete',
    'status_id', 'priority', 'due_date',
  ],
  tasklist: ['id', 'name', 'project_id', 'seq', 'milestone_id', 'tasks_count'],
  workflowstatus: ['id', 'workflow_id', 'name', 'seq', 'action', 'color'],
  entry: [
    'id', 'task_id', 'user_id', 'project_id', 'start_time', 'end_time', 'duration',
    'description', 'billable',
  ],
};

/**
 * Returns the documented subset of a record, dropping every other field. Missing subset keys are
 * tolerated — a record that never had a `due_date` simply omits it. `verbose` returns the raw
 * record untouched.
 */
export function filterRecord(record: PaymoRecord, kind: RecordKind, verbose: boolean): PaymoRecord {
  if (verbose) {
    return record;
  }

  const subset = SUBSETS[kind];
  const out: PaymoRecord = {};

  for (const key of subset) {
    if (record[key] !== undefined) {
      out[key] = record[key];
    }
  }

  return out;
}

/**
 * Slices a record list to `limit` records starting at `offset`. An omitted `limit` returns
 * everything from `offset` on, matching the existing behaviour of returning full lists.
 */
export function paginate<T>(records: readonly T[], limit: number | undefined, offset: number): T[] {
  return records.slice(offset, limit === undefined ? undefined : offset + limit);
}
