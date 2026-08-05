import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PaymoClient } from '../src/client.ts';
import { PaymoHttpError } from '../src/client.ts';
import type { PermissionMode } from '../src/config.ts';
import { StatusResolver } from '../src/statuses.ts';
import { registerTools, resolveTools } from '../src/tools/index.ts';
import { TOOLS, TOOLSETS } from '../src/tools/index.ts';
import { respond } from '../src/tools/shared.ts';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface HarnessOverrides {
  permissionMode?: PermissionMode;
  registeredTools?: ReadonlySet<string>;
}

/**
 * Collects the registered handlers so a tool can be invoked without a transport. Arguments are
 * parsed through the tool's own zod schema first, exactly as the SDK does — otherwise `.default()`
 * values never apply and a wrong default is invisible to every test here.
 *
 * Registered tools default to the whole registry; `permissionMode` controls which of them survive
 * `registerTools`, mirroring how `resolveTools` + `registerTools` behave at startup. Override
 * `registeredTools` when a test needs a particular tool absent regardless of the permission mode.
 */
function handlersFor(client: Partial<PaymoClient>, overrides: HarnessOverrides = {}): Map<string, Handler> {
  const permissionMode = overrides.permissionMode ?? 'modify';
  const registeredTools = overrides.registeredTools ?? new Set(Object.keys(TOOLS));
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
    permissionMode,
    registeredTools,
  });

  return handlers;
}

function resolve(config: {
  toolsets?: string[];
  tools?: string[];
  denied?: RegExp | null;
  mode?: PermissionMode;
}): Set<string> {
  return resolveTools({
    toolsets: config.toolsets ?? [],
    tools: config.tools ?? [],
    deniedToolsRegex: config.denied ?? null,
    permissionMode: config.mode ?? 'modify',
  });
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

test('read-only mode registers the read tools only; full registers all 13', () => {
  const readOnly = handlersFor({}, { permissionMode: 'readonly' });
  const full = handlersFor({}, { permissionMode: 'full' });

  assert.equal(readOnly.size, 7);
  assert.equal(full.size, 13);
  assert.equal(readOnly.has('paymo_update_task'), false);
  assert.equal(readOnly.has('paymo_delete_entry'), false);
});

test('default mode registers 12 of 13 tools, everything except paymo_delete_entry', () => {
  const handlers = handlersFor({});

  assert.equal(handlers.size, 12);
  assert.equal(handlers.has('paymo_delete_entry'), false);
  assert.equal(handlers.has('paymo_stop_timer'), true);
  assert.equal(handlers.has('paymo_create_task'), true);
});

test('every toolset entry names a tool that exists in the registry', () => {
  for (const [set, names] of Object.entries(TOOLSETS)) {
    for (const name of names) {
      assert.ok(TOOLS[name] !== undefined, `toolset '${set}' references unknown tool '${name}'`);
    }
  }
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

test('empty toolset selection resolves to the default toolsets (context, tasks, time)', () => {
  const names = resolve({ mode: 'full' });

  assert.equal(names.size, 13);
  assert.equal(names.has('paymo_me'), true);
  assert.equal(names.has('paymo_create_task'), true);
  assert.equal(names.has('paymo_delete_entry'), true);
});

test('the all keyword expands to every toolset', () => {
  const names = resolve({ toolsets: ['all'], mode: 'full' });

  assert.equal(names.size, 13);
});

test('default is a keyword, so default,<toolset> adds instead of replacing', () => {
  const names = resolve({ toolsets: ['default', 'context'], mode: 'full' });

  assert.equal(names.size, 13);
});

test('toolset names are additive, case-insensitive and whitespace-tolerant', () => {
  const context = resolve({ toolsets: ['context'], mode: 'full' });

  assert.deepEqual([...context].sort(), ['paymo_list_workflow_statuses', 'paymo_me']);

  const timeAndContext = resolve({ toolsets: [' time ', 'CONTEXT'], mode: 'full' });

  assert.equal(timeAndContext.size, 6);
  assert.equal(timeAndContext.has('paymo_start_timer'), true);
  assert.equal(timeAndContext.has('paymo_me'), true);
});

test('an unknown toolset aborts and lists the valid values', () => {
  assert.throws(
    () => resolve({ toolsets: ['billing'] }),
    /Unknown toolset 'billing'.*Valid toolsets:.*context/,
  );
});

test('PAYMO_TOOLS unions in a tool from an unselected toolset', () => {
  const names = resolve({ toolsets: ['context'], tools: ['paymo_delete_entry'], mode: 'full' });

  assert.equal(names.has('paymo_delete_entry'), true);
  assert.equal(names.has('paymo_me'), true);
  assert.equal(names.has('paymo_list_tasks'), false);
});

test('an unknown PAYMO_TOOLS name aborts and lists the valid values', () => {
  assert.throws(() => resolve({ tools: ['paymo_nope'] }), /Unknown tool 'paymo_nope'.*Valid tools:/);
});

test('the deny regex subtracts last, even a tool explicitly named in PAYMO_TOOLS', () => {
  const names = resolve({
    toolsets: ['all'],
    tools: ['paymo_create_task'],
    denied: /^paymo_create/,
    mode: 'full',
  });

  assert.equal(names.has('paymo_create_task'), false);
  assert.equal(names.size, 12);
});

test('permission mode wins over every explicit selection', () => {
  const readonly = resolve({ tools: ['paymo_update_task'], mode: 'readonly' });
  const modify = resolve({ tools: ['paymo_delete_entry'], mode: 'modify' });
  const full = resolve({ tools: ['paymo_update_task', 'paymo_delete_entry'], mode: 'full' });

  assert.equal(readonly.has('paymo_update_task'), false);
  assert.equal(modify.has('paymo_delete_entry'), false);
  assert.equal(full.has('paymo_update_task'), true);
  assert.equal(full.has('paymo_delete_entry'), true);
});

test('a selection that resolves to no tools aborts', () => {
  assert.throws(() => resolve({ denied: /./ }), /resolved to no tools/);
});

test('stop_timer names paymo_delete_entry and its mode when the sub-minute stop fails', async () => {
  const subMinute = new Date(Date.now() - 30_000).toISOString();
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => ({ id: 1, start_time: subMinute, end_time: null, duration: 0 }),
    stopEntry: async () => {
      throw new PaymoHttpError(400, '{"error":"refused"}');
    },
  });

  const result = await handlers.get('paymo_stop_timer')!({});
  const text = (result.content?.[0] as { text: string }).text;

  assert.equal(result.isError, true);
  assert.match(text, /under a minute old/);
  assert.match(text, /paymo_delete_entry/);
  assert.match(text, /PAYMO_PERMISSION_MODE=full/);
});

test('stop_timer leaves the raw error alone when paymo_delete_entry is registered', async () => {
  const subMinute = new Date(Date.now() - 30_000).toISOString();
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => ({ id: 1, start_time: subMinute, end_time: null, duration: 0 }),
    stopEntry: async () => {
      throw new PaymoHttpError(400, '{"error":"refused"}');
    },
  }, { permissionMode: 'full' });

  const result = await handlers.get('paymo_stop_timer')!({});
  const text = (result.content?.[0] as { text: string }).text;

  assert.equal(result.isError, true);
  assert.equal(text.includes('paymo_delete_entry'), false);
  assert.match(text, /refused/);
});

test('stop_timer does not blame the minute rule when the entry is not sub-minute', async () => {
  const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => ({ id: 1, start_time: tenMinutesAgo, end_time: null, duration: 600 }),
    stopEntry: async () => {
      throw new PaymoHttpError(400, '{"error":"refused"}');
    },
  });

  const result = await handlers.get('paymo_stop_timer')!({});
  const text = (result.content?.[0] as { text: string }).text;

  assert.equal(text.includes('paymo_delete_entry'), false);
  assert.match(text, /refused/);
});

test('a 429 on a young entry is reported as a rate limit, not as the sub-minute rule', async () => {
  const subMinute = new Date(Date.now() - 20_000).toISOString();
  const handlers = handlersFor({
    currentUserId: async () => 9,
    runningEntry: async () => ({ id: 1, start_time: subMinute, end_time: null, duration: 0 }),
    stopEntry: async () => {
      throw new PaymoHttpError(429, '{"message":"Too Many Requests"}');
    },
  });

  const result = await handlers.get('paymo_stop_timer')!({});
  const text = (result.content?.[0] as { text: string }).text;

  assert.equal(result.isError, true);
  assert.match(text, /429/);
  assert.equal(text.includes('under a minute old'), false);
});
