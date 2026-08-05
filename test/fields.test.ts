import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUBSETS, filterRecord, paginate } from '../src/fields.ts';

test('filterRecord keeps only the documented subset keys and drops the rest', () => {
  const record = {
    id: 1234,
    name: 'Website redesign',
    code: 'WEB',
    flat_billing: true,
    invoice_item_id: 5678,
    color: '#ff0000',
    settings: { x: 1 },
  };

  assert.deepEqual(filterRecord(record, 'project', false), {
    id: 1234,
    name: 'Website redesign',
    code: 'WEB',
  });
});

test('filterRecord tolerates a missing subset key instead of emitting it', () => {
  const record = { id: 1234, name: 'Task without a code or due date' };

  assert.deepEqual(filterRecord(record, 'task', false), {
    id: 1234,
    name: 'Task without a code or due date',
  });
});

test('filterRecord with verbose returns the raw record untouched', () => {
  const record = {
    id: 1234,
    name: 'Full project',
    flat_billing: true,
    invoice_item_id: 5678,
    color: '#ff0000',
  };

  assert.deepEqual(filterRecord(record, 'project', true), record);
});

test('paginate without a limit returns everything from the offset on', () => {
  const records = [{ id: 1 }, { id: 2 }, { id: 3 }];

  assert.deepEqual(paginate(records, undefined, 0), records);
  assert.deepEqual(paginate(records, undefined, 2), [{ id: 3 }]);
});

test('paginate with a limit truncates and combines with the offset', () => {
  const records = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  assert.deepEqual(paginate(records, 2, 0), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(paginate(records, 2, 2), [{ id: 3 }, { id: 4 }]);
  assert.deepEqual(paginate(records, 100, 3), [{ id: 4 }]);
});

test('filterRecord keeps the whole entry subset that paymo_timer_status relies on', () => {
  const entry = {
    id: 9,
    task_id: 1234,
    user_id: 5678,
    project_id: 1234,
    start_time: '2026-08-05T10:00:00Z',
    end_time: null,
    duration: 0,
    description: 'smoke test',
    billable: true,
    cover_file_id: 999,
  };

  assert.deepEqual(filterRecord(entry, 'entry', false), {
    id: 9,
    task_id: 1234,
    user_id: 5678,
    project_id: 1234,
    start_time: '2026-08-05T10:00:00Z',
    end_time: null,
    duration: 0,
    description: 'smoke test',
    billable: true,
  });
});

test('the task subset keeps `users`, because update_task replaces the assignee list wholesale', () => {
  const task = {
    id: 1234,
    code: 'ABC-1',
    name: 'Task',
    user_id: 11,
    users: [11, 22, 33],
    cover_file_id: 999,
  };

  const filtered = filterRecord(task, 'task', false);

  assert.deepEqual(filtered.users, [11, 22, 33]);
  assert.equal('cover_file_id' in filtered, false);
});

test('projectSummary is a strict subset of the project detail subset', () => {
  for (const key of SUBSETS.projectSummary) {
    assert.ok(SUBSETS.project.includes(key), `projectSummary field '${key}' is not in the project detail subset`);
  }

  assert.ok(SUBSETS.projectSummary.length < SUBSETS.project.length);
});

test('taskSummary is a strict subset of the task detail subset and keeps users', () => {
  for (const key of SUBSETS.taskSummary) {
    assert.ok(SUBSETS.task.includes(key), `taskSummary field '${key}' is not in the task detail subset`);
  }

  assert.ok(SUBSETS.task.includes('users'), 'the task detail subset must keep users');
  assert.ok(SUBSETS.taskSummary.includes('users'), 'the task summary must keep users, same data-loss argument as the detail subset');
  assert.ok(SUBSETS.taskSummary.length < SUBSETS.task.length);
});

test('projectSummary drops the heavy detail fields a listing does not need', () => {
  const project = {
    id: 1234,
    name: 'Website redesign',
    code: 'WEB',
    active: true,
    client_id: 5678,
    client_name: 'Acme',
    description: 'long body',
    workflow_id: 1,
    status_id: 2,
    seq: 3,
    created_on: '2026-01-01T00:00:00Z',
    updated_on: '2026-01-02T00:00:00Z',
    flat_billing: true,
    color: '#fff',
  };

  assert.deepEqual(filterRecord(project, 'projectSummary', false), {
    id: 1234,
    name: 'Website redesign',
    code: 'WEB',
    active: true,
    client_id: 5678,
    client_name: 'Acme',
  });
});

test('projectTemplate subset keeps id, name and description', () => {
  const template = { id: 1234, name: 'Web', description: 'a template', budget_hours: 40 };

  assert.deepEqual(filterRecord(template, 'projectTemplate', false), {
    id: 1234,
    name: 'Web',
    description: 'a template',
  });
});

test('projectStatus subset keeps id, name, seq and active, dropping readonly', () => {
  const status = {
    id: 1234,
    name: 'On-hold',
    active: false,
    seq: 2,
    readonly: false,
    created_on: '2017-07-13T03:36:22Z',
  };

  assert.deepEqual(filterRecord(status, 'projectStatus', false), {
    id: 1234,
    name: 'On-hold',
    active: false,
    seq: 2,
  });
});

test('project subset exposes budget_hours and billable now that write tools accept them', () => {
  const project = {
    id: 1234,
    name: 'X',
    budget_hours: 40,
    billable: true,
    invoiced: 12,
  };

  assert.deepEqual(filterRecord(project, 'project', false), {
    id: 1234,
    name: 'X',
    budget_hours: 40,
    billable: true,
  });
});
