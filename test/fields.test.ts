import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterRecord, paginate } from '../src/fields.ts';

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
