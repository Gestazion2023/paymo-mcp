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

test('read-only mode registers the read tools only; full registers all 34', () => {
  const readOnly = handlersFor({}, { permissionMode: 'readonly' });
  const full = handlersFor({}, { permissionMode: 'full' });

  assert.equal(readOnly.size, 20);
  assert.equal(full.size, 34);
  assert.equal(readOnly.has('paymo_update_task'), false);
  assert.equal(readOnly.has('paymo_delete_entry'), false);
});

test('default mode registers 33 of 34 tools, everything except paymo_delete_entry', () => {
  const handlers = handlersFor({});

  assert.equal(handlers.size, 33);
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

  assert.equal(names.size, 34);
  assert.equal(names.has('paymo_create_project'), true);
  assert.equal(names.has('paymo_list_clients'), true);
  assert.equal(names.has('paymo_list_invoices'), true);
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
    () => resolve({ toolsets: ['bogus'] }),
    /Unknown toolset 'bogus'.*Valid toolsets:.*context/,
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
  assert.equal(names.size, 29);
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

test('get_project returns the project detail subset', async () => {
  const handlers = handlersFor({
    project: async () => ({
      id: 1234,
      name: 'Site',
      code: 'S',
      budget_hours: 40,
      billable: true,
      invoiced: 12,
    }),
  });

  const result = await handlers.get('paymo_get_project')!({ project_id: 1234, verbose: false });

  assert.deepEqual(payloadOf(result), {
    id: 1234,
    name: 'Site',
    code: 'S',
    budget_hours: 40,
    billable: true,
  });
});

test('create_project forwards every create field, template_id included', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    createProject: async (data) => {
      captured = data;
      return { id: 1 };
    },
  });

  const result = await handlers.get('paymo_create_project')!({
    name: 'New',
    code: 'N',
    client_id: 5,
    template_id: 9,
    description: 'd',
    budget_hours: 10,
    billable: false,
  });

  assert.deepEqual(payloadOf(result), { id: 1 });
  assert.deepEqual(captured, {
    name: 'New',
    code: 'N',
    client_id: 5,
    template_id: 9,
    description: 'd',
    budget_hours: 10,
    billable: false,
  });
});

test('update_project forwards active and status_id as the archive path', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    updateProject: async (_id, data) => {
      captured = data;
      return { id: 1, active: false };
    },
  });

  await handlers.get('paymo_update_project')!({ project_id: 1, active: false, status_id: 3 });

  assert.deepEqual(captured, { active: false, status_id: 3 });
});

test('create_tasklist requires a project_id and name and forwards optional fields', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    createTasklist: async (data) => {
      captured = data;
      return { id: 1 };
    },
  });

  await handlers.get('paymo_create_tasklist')!({ project_id: 1234, name: 'Backlog', seq: 0 });

  assert.deepEqual(captured, { project_id: 1234, name: 'Backlog', seq: 0 });
});

test('the projects toolset registers its reads under readonly and all nine under modify', () => {
  const registered = new Set(TOOLSETS.projects);
  const readOnly = handlersFor({}, { permissionMode: 'readonly', registeredTools: registered });
  const modify = handlersFor({}, { permissionMode: 'modify', registeredTools: registered });

  assert.equal(readOnly.size, 5);
  assert.equal(modify.size, 9);
  assert.equal(readOnly.has('paymo_update_project'), false);
  assert.equal(readOnly.has('paymo_get_project'), true);
  assert.equal(modify.has('paymo_create_project'), true);
});

test('the clients toolset registers its reads under readonly and all eight under modify', () => {
  const registered = new Set(TOOLSETS.clients);
  const readOnly = handlersFor({}, { permissionMode: 'readonly', registeredTools: registered });
  const modify = handlersFor({}, { permissionMode: 'modify', registeredTools: registered });

  assert.equal(readOnly.size, 4);
  assert.equal(modify.size, 8);
  assert.equal(readOnly.has('paymo_update_client'), false);
  assert.equal(readOnly.has('paymo_get_company'), true);
  assert.equal(readOnly.has('paymo_list_client_contacts'), true);
  assert.equal(modify.has('paymo_create_client'), true);
});

test('list_clients applies the client summary subset and honors limit and offset', async () => {
  const handlers = handlersFor({
    clients: async () => [
      { id: 1234, name: 'Acme', email: 'a@acme.com', country: 'US', active: true, phone: '555', image: 'http://x/logo.png' },
      { id: 5678, name: 'Globex', email: 'g@globex.com', country: 'GB', active: false, phone: '666', image: 'http://y/logo.png' },
    ],
  });

  const result = await handlers.get('paymo_list_clients')!({
    active: true,
    limit: 1,
    offset: 1,
    verbose: false,
  });

  assert.deepEqual(payloadOf(result), [
    { id: 5678, name: 'Globex', email: 'g@globex.com', country: 'GB', active: false },
  ]);
});

test('list_clients verbose returns each raw client untouched', async () => {
  const raw = { id: 1234, name: 'Acme', phone: '555', image: 'http://x/logo.png' };
  const handlers = handlersFor({ clients: async () => [raw] });

  const result = await handlers.get('paymo_list_clients')!({
    active: true,
    limit: 5,
    offset: 0,
    verbose: true,
  });

  assert.deepEqual(payloadOf(result), [raw]);
});

test('get_client returns the client detail subset with the write fields visible', async () => {
  const handlers = handlersFor({
    client: async () => ({
      id: 1234,
      name: 'Acme',
      country: 'US',
      fiscal_information: 'VATFIXTURE',
      active: true,
      image: 'http://x/logo.png',
    }),
  });

  const result = await handlers.get('paymo_get_client')!({ client_id: 1234, verbose: false });

  assert.deepEqual(payloadOf(result), {
    id: 1234,
    name: 'Acme',
    country: 'US',
    fiscal_information: 'VATFIXTURE',
    active: true,
  });
});

test('list_client_contacts filters by client_id and keeps the contact write fields', async () => {
  let requestedClient: number | null = null;
  const handlers = handlersFor({
    clientContacts: async (clientId) => {
      requestedClient = clientId;
      return [{
        id: 1,
        client_id: 1234,
        name: 'Aaron Cooper',
        email: 'aaron@x.com',
        mobile: '555-0100',
        phone: '555-0101',
        fax: '555-0102',
        skype: 'aaron.c',
        position: 'CEO',
        is_main: true,
        access: false,
        notes: 'prefers email',
        image: 'http://x/contact.jpg',
        created_on: '2013-07-24T11:52:44Z',
      }];
    },
  });

  const result = await handlers.get('paymo_list_client_contacts')!({
    client_id: 1234,
    limit: 10,
    offset: 0,
    verbose: false,
  });

  assert.equal(requestedClient, 1234);
  assert.deepEqual(payloadOf(result), [{
    id: 1,
    client_id: 1234,
    name: 'Aaron Cooper',
    email: 'aaron@x.com',
    mobile: '555-0100',
    phone: '555-0101',
    fax: '555-0102',
    skype: 'aaron.c',
    position: 'CEO',
    is_main: true,
    access: false,
    notes: 'prefers email',
  }]);
});

test('get_company returns the company subset with invoicing defaults', async () => {
  const handlers = handlersFor({
    company: async () => ({
      id: 1234,
      name: 'Gestazion',
      default_currency: 'EUR',
      invoice_format: '#INV-[yyyy][mm][dd]-[i]',
      account_type: 'commercial',
      max_users: 4,
      image: 'http://x/logo.png',
    }),
  });

  const result = await handlers.get('paymo_get_company')!({ verbose: false });

  assert.deepEqual(payloadOf(result), {
    id: 1234,
    name: 'Gestazion',
    default_currency: 'EUR',
    invoice_format: '#INV-[yyyy][mm][dd]-[i]',
  });
});

test('create_client forwards every create field', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    createClient: async (data) => {
      captured = data;
      return { id: 1 };
    },
  });

  const result = await handlers.get('paymo_create_client')!({
    name: 'Acme',
    email: 'sales@acme.com',
    country: 'US',
    fiscal_information: 'VATFIXTURE',
  });

  assert.deepEqual(payloadOf(result), { id: 1 });
  assert.deepEqual(captured, {
    name: 'Acme',
    email: 'sales@acme.com',
    country: 'US',
    fiscal_information: 'VATFIXTURE',
  });
});

test('update_client forwards active as the archive path and nothing else when absent', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    updateClient: async (_id, data) => {
      captured = data;
      return { id: 1, active: false };
    },
  });

  await handlers.get('paymo_update_client')!({ client_id: 1, active: false });

  assert.deepEqual(captured, { active: false });
});

test('create_client_contact requires a name and client_id and forwards the portal password', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    createClientContact: async (data) => {
      captured = data;
      return { id: 1 };
    },
  });

  await handlers.get('paymo_create_client_contact')!({
    client_id: 1234,
    name: 'Aaron',
    position: 'CEO',
    access: true,
    password: 'secret',
  });

  assert.deepEqual(captured, {
    client_id: 1234,
    name: 'Aaron',
    position: 'CEO',
    access: true,
    password: 'secret',
  });
});

test('update_client_contact forwards a changed subset and the portal access grant', async () => {
  let captured: unknown;
  const handlers = handlersFor({
    updateClientContact: async (_id, data) => {
      captured = data;
      return { id: 1 };
    },
  });

  await handlers.get('paymo_update_client_contact')!({
    contact_id: 1,
    phone: '555-0199',
    access: true,
    password: 'secret',
  });

  assert.deepEqual(captured, { phone: '555-0199', access: true, password: 'secret' });
});

test('the billing toolset is all read: six tools under readonly and under modify', () => {
  const registered = new Set(TOOLSETS.billing);
  const readOnly = handlersFor({}, { permissionMode: 'readonly', registeredTools: registered });
  const modify = handlersFor({}, { permissionMode: 'modify', registeredTools: registered });

  assert.equal(readOnly.size, 6);
  assert.equal(modify.size, 6);
  assert.equal(readOnly.has('paymo_get_invoice'), true);
  assert.equal(readOnly.has('paymo_list_estimates'), true);
  assert.equal(readOnly.has('paymo_list_invoice_payments'), true);
});

test('list_invoices filters by status and client and returns the summary subset', async () => {
  let requestedWhere: string | undefined;
  const handlers = handlersFor({
    invoices: async (where) => {
      requestedWhere = where;
      return [{
        id: 1234,
        number: '#1041',
        client_id: 5,
        status: 'paid',
        currency: 'EUR',
        date: '2026-01-01',
        due_date: '2026-02-01',
        total: 100,
        bill_to: 'Acme',
        download_token: 'secret-token',
        invoiceitems: [{ id: 1 }],
      }];
    },
  });

  const result = await handlers.get('paymo_list_invoices')!({
    status: 'paid',
    client_id: 5,
    limit: 10,
    offset: 0,
    verbose: false,
  });

  assert.equal(requestedWhere, 'status=paid and client_id=5');
  assert.deepEqual(payloadOf(result), [{
    id: 1234,
    number: '#1041',
    client_id: 5,
    status: 'paid',
    currency: 'EUR',
    date: '2026-01-01',
    due_date: '2026-02-01',
    total: 100,
  }]);
});

test('list_invoices with no filters passes no where clause', async () => {
  let requestedWhere: string | undefined;
  const handlers = handlersFor({
    invoices: async (where) => {
      requestedWhere = where;
      return [{ id: 1234, number: '#1041', status: 'draft', total: 0 }];
    },
  });

  await handlers.get('paymo_list_invoices')!({ limit: 10, offset: 0, verbose: false });

  assert.equal(requestedWhere, undefined);
});

test('list_invoices verbose returns each raw invoice untouched', async () => {
  const raw = {
    id: 1234,
    number: '#1041',
    client_id: 5,
    status: 'draft',
    download_token: 'secret-token',
  };
  const handlers = handlersFor({ invoices: async () => [raw] });

  const result = await handlers.get('paymo_list_invoices')!({
    limit: 5,
    offset: 0,
    verbose: true,
  });

  assert.deepEqual(payloadOf(result), [raw]);
});

test('get_invoice returns the invoice detail subset including line items', async () => {
  const handlers = handlersFor({
    invoice: async () => ({
      id: 1234,
      number: '#1041',
      client_id: 5,
      status: 'paid',
      currency: 'EUR',
      total: 100,
      subtotal: 80,
      invoiceitems: [{ id: 1, item: 'Logo', price_unit: 40, quantity: 2 }],
      download_token: 'secret-token',
      permalink: 'https://app.paymoapp.com/api/invoices/1234/?token=x',
    }),
  });

  const result = await handlers.get('paymo_get_invoice')!({ invoice_id: 1234, verbose: false });

  assert.deepEqual(payloadOf(result), {
    id: 1234,
    number: '#1041',
    client_id: 5,
    status: 'paid',
    currency: 'EUR',
    total: 100,
    subtotal: 80,
    invoiceitems: [{ id: 1, item: 'Logo', price_unit: 40, quantity: 2 }],
  });
});

test('list_invoice_payments filters by invoice_id and keeps the payment fields', async () => {
  let requestedInvoice: number | null = null;
  const handlers = handlersFor({
    invoicePayments: async (invoiceId) => {
      requestedInvoice = invoiceId;
      return [{
        id: 1234,
        invoice_id: 5678,
        amount: 15.25,
        date: '2026-09-28',
        notes: 'bank transfer',
        created_on: '2026-09-28T19:20:03Z',
        updated_on: '2026-09-28T19:20:03Z',
      }];
    },
  });

  const result = await handlers.get('paymo_list_invoice_payments')!({
    invoice_id: 5678,
    limit: 10,
    offset: 0,
    verbose: false,
  });

  assert.equal(requestedInvoice, 5678);
  assert.deepEqual(payloadOf(result), [{
    id: 1234,
    invoice_id: 5678,
    amount: 15.25,
    date: '2026-09-28',
    notes: 'bank transfer',
    created_on: '2026-09-28T19:20:03Z',
    updated_on: '2026-09-28T19:20:03Z',
  }]);
});

test('list_invoice_payments with no invoice_id lists every payment', async () => {
  let requestedInvoice: number | null = null;
  const handlers = handlersFor({
    invoicePayments: async (invoiceId) => {
      requestedInvoice = invoiceId;
      return [];
    },
  });

  await handlers.get('paymo_list_invoice_payments')!({ limit: 10, offset: 0, verbose: false });

  assert.equal(requestedInvoice, null);
});

test('list_estimates filters by status and client and returns the summary subset', async () => {
  let requestedWhere: string | undefined;
  const handlers = handlersFor({
    estimates: async (where) => {
      requestedWhere = where;
      return [{
        id: 1234,
        number: '#2013',
        client_id: 5,
        status: 'draft',
        currency: 'EUR',
        date: '2026-01-01',
        total: 50,
        invoice_id: null,
        download_token: 'secret-token',
      }];
    },
  });

  const result = await handlers.get('paymo_list_estimates')!({
    status: 'draft',
    client_id: 5,
    limit: 10,
    offset: 0,
    verbose: false,
  });

  assert.equal(requestedWhere, 'status=draft and client_id=5');
  assert.deepEqual(payloadOf(result), [{
    id: 1234,
    number: '#2013',
    client_id: 5,
    status: 'draft',
    currency: 'EUR',
    date: '2026-01-01',
    total: 50,
  }]);
});

test('get_estimate returns the estimate detail subset including line items', async () => {
  const handlers = handlersFor({
    estimate: async () => ({
      id: 1234,
      number: '#2013',
      client_id: 5,
      status: 'sent',
      currency: 'EUR',
      date: '2026-01-01',
      total: 50,
      invoice_id: null,
      estimateitems: [{ id: 1, item: 'Logo', price_unit: 40, quantity: 1 }],
      permalink: 'https://app.paymoapp.com/api/estimates/1234/?token=x',
    }),
  });

  const result = await handlers.get('paymo_get_estimate')!({ estimate_id: 1234, verbose: false });

  assert.deepEqual(payloadOf(result), {
    id: 1234,
    number: '#2013',
    client_id: 5,
    status: 'sent',
    currency: 'EUR',
    date: '2026-01-01',
    total: 50,
    invoice_id: null,
    estimateitems: [{ id: 1, item: 'Logo', price_unit: 40, quantity: 1 }],
  });
});

test('list_invoice_templates keeps the layout identity and drops the html and css bodies', async () => {
  const handlers = handlersFor({
    invoiceTemplates: async () => [{
      id: 1234,
      name: 'English - Client on right',
      title: 'INVOICE',
      is_default: false,
      html: '<div class="invoice">very long template body</div>',
      css: '#invoice-title { color: #999; }',
      created_on: '2014-11-19T09:45:32Z',
    }],
  });

  const result = await handlers.get('paymo_list_invoice_templates')!({
    limit: 10,
    offset: 0,
    verbose: false,
  });

  assert.deepEqual(payloadOf(result), [{
    id: 1234,
    name: 'English - Client on right',
    title: 'INVOICE',
    is_default: false,
  }]);
});
