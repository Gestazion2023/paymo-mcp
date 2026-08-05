import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PaymoClient } from '../src/client.ts';
import { PaymoHttpError } from '../src/client.ts';
import { StatusResolver } from '../src/statuses.ts';
import { registerTools, respond } from '../src/tools.ts';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Collects the registered handlers so a tool can be invoked without a transport. Arguments are
 * parsed through the tool's own zod schema first, exactly as the SDK does — otherwise `.default()`
 * values never apply and a wrong default is invisible to every test here.
 */
function handlersFor(client: Partial<PaymoClient>, readOnly = false): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (
      name: string,
      def: { inputSchema?: Record<string, z.ZodTypeAny> },
      handler: Handler,
    ) => {
      const schema = z.object(def.inputSchema ?? {});

      handlers.set(name, (args) => handler(schema.parse(args) as Record<string, unknown>));
    },
  } as unknown as McpServer;

  registerTools(server, {
    client: client as PaymoClient,
    resolver: new StatusResolver(),
    defaultProjectId: null,
    readOnly,
  });

  return handlers;
}

function payloadOf(result: CallToolResult): unknown {
  return JSON.parse((result.content?.[0] as { text: string }).text);
}

test("respond returns the JSON-encoded payload as text on success", async () => {
  const result = await respond("get me", async () => ({ id: 1, name: "a" }));

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content?.[0], { type: "text", text: '{"id":1,"name":"a"}' });
});

test('respond turns a thrown error into an MCP error result, not a rejection', async () => {
  const result = await respond('get me', async () => {
    throw new PaymoHttpError(401, '{"error":"unauthorized"}');
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.content?.[0] as { text: string }).text,
    /Paymo get me failed: Paymo API returned 401: /,
  );
});

test('start_timer reports the closed entry as it is after stopping, not before', async () => {
  const stopped = { id: 1, end_time: '2026-08-05T10:00:41Z', duration: 41 };
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => ({ id: 1, end_time: null, duration: 0 }),
    stopEntry: async () => stopped,
    resolveTaskId: async () => 1234,
    startEntry: async () => ({ id: 2, task_id: 1234 }),
  });

  const result = await handlers.get('paymo_start_timer')!({ task: '1234' });

  assert.deepEqual(payloadOf(result), { started: { id: 2, task_id: 1234 }, previous_closed: stopped });
});

test('start_timer reports no previous entry when nothing was running', async () => {
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => null,
    stopEntry: async () => assert.fail('must not stop anything'),
    resolveTaskId: async () => 1234,
    startEntry: async () => ({ id: 2, task_id: 1234 }),
  });

  const result = await handlers.get('paymo_start_timer')!({ task: '1234' });

  assert.deepEqual(payloadOf(result), { started: { id: 2, task_id: 1234 }, previous_closed: null });
});

test('read-only mode registers the read tools only', () => {
  const readOnly = handlersFor({}, true);
  const readWrite = handlersFor({}, false);

  assert.equal(readOnly.size, 7);
  assert.equal(readWrite.size, 13);
  assert.equal(readOnly.has('paymo_update_task'), false);
  assert.equal(readOnly.has('paymo_delete_entry'), false);
});

test('paymo_list_projects applies the field subset and honors limit and offset', async () => {
  const handlers = handlersFor({
    projects: async () => [
      { id: 1234, name: 'Alpha', code: 'A', flat_billing: true, color: '#fff' },
      { id: 5678, name: 'Beta', code: 'B', flat_billing: false, color: '#000' },
      { id: 9012, name: 'Gamma', code: 'C', budget_hours: 40 },
    ],
  });

  const result = await handlers.get('paymo_list_projects')!({
    active: true,
    limit: 2,
    offset: 1,
    verbose: false,
  });

  assert.deepEqual(payloadOf(result), [
    { id: 5678, name: 'Beta', code: 'B' },
    { id: 9012, name: 'Gamma', code: 'C' },
  ]);
});

test('list_projects verbose returns each raw project untouched', async () => {
  const raw = { id: 1234, name: 'Alpha', code: 'A', flat_billing: true, color: '#fff' };
  const handlers = handlersFor({ projects: async () => [raw] });

  const result = await handlers.get('paymo_list_projects')!({
    active: true,
    limit: 5,
    offset: 0,
    verbose: true,
  });

  assert.deepEqual(payloadOf(result), [raw]);
});

test('list_tasks returns the task summary, keeping users and dropping description', async () => {
  const handlers = handlersFor({
    tasks: async () => [{
      id: 1234,
      name: 'Ship the report',
      code: 'ABC-1',
      project_id: 5678,
      tasklist_id: 90,
      users: [11, 22],
      complete: false,
      status_id: 1,
      priority: 50,
      due_date: '2026-08-10',
      description: 'long body the listing does not need',
      start_date: '2026-08-01',
      seq: 3,
      created_on: '2026-01-01T00:00:00Z',
    }],
  });

  const result = await handlers.get('paymo_list_tasks')!({
    project_id: 5678,
    include_completed: false,
    limit: 10,
    offset: 0,
    verbose: false,
  });

  assert.deepEqual(payloadOf(result), [{
    id: 1234,
    name: 'Ship the report',
    code: 'ABC-1',
    project_id: 5678,
    tasklist_id: 90,
    users: [11, 22],
    complete: false,
    status_id: 1,
    priority: 50,
    due_date: '2026-08-10',
  }]);
});

test('timer_status filters the running entry to the documented subset', async () => {
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => ({
      id: 9,
      task_id: 1234,
      start_time: '2026-08-05T10:00:00Z',
      end_time: null,
      duration: 0,
      cover_file_id: 999,
    }),
  });

  const result = await handlers.get('paymo_timer_status')!({ verbose: false });

  assert.deepEqual(payloadOf(result), {
    running: {
      id: 9,
      task_id: 1234,
      start_time: '2026-08-05T10:00:00Z',
      end_time: null,
      duration: 0,
    },
  });
});

test('list tools cap the response at 50 records unless a larger limit is asked for', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, name: `P${i}`, code: 'X' }));
  const handlers = handlersFor({ projects: async () => many });

  const capped = await handlers.get('paymo_list_projects')!({ active: true, offset: 0, verbose: false });
  assert.equal((payloadOf(capped) as unknown[]).length, 50);

  const raised = await handlers.get('paymo_list_projects')!({
    active: true,
    limit: 120,
    offset: 0,
    verbose: false,
  });
  assert.equal((payloadOf(raised) as unknown[]).length, 120);
});
