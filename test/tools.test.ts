import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PaymoClient } from '../src/client.ts';
import { PaymoHttpError } from '../src/client.ts';
import { StatusResolver } from '../src/statuses.ts';
import { registerTools, respond } from '../src/tools.ts';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Collects the registered handlers so a tool can be invoked without a transport. */
function handlersFor(client: Partial<PaymoClient>, readOnly = false): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => handlers.set(name, handler),
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
  assert.equal(readWrite.size, 12);
  assert.equal(readOnly.has('paymo_update_task'), false);
});