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

test('comment subset keeps the author, the body and the threading fields', () => {
  const comment = {
    id: 1234,
    task_id: 5678,
    thread_id: 90,
    reply_id: null,
    user_id: 11,
    content: '<p>looks good</p>',
    created_on: '2026-08-01T09:00:00Z',
    updated_on: '2026-08-01T09:05:00Z',
    seen_by: [11, 22],
    attachments: [],
  };

  assert.deepEqual(filterRecord(comment, 'comment', false), {
    id: 1234,
    task_id: 5678,
    thread_id: 90,
    reply_id: null,
    user_id: 11,
    content: '<p>looks good</p>',
    created_on: '2026-08-01T09:00:00Z',
    updated_on: '2026-08-01T09:05:00Z',
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

test('clientSummary is a strict subset of the client detail subset', () => {
  for (const key of SUBSETS.clientSummary) {
    assert.ok(SUBSETS.client.includes(key), `clientSummary field '${key}' is not in the client detail subset`);
  }

  assert.ok(SUBSETS.clientSummary.length < SUBSETS.client.length);
});

test('client detail subset keeps every field the write tools accept and drops logo images', () => {
  const record = {
    id: 1234,
    name: 'Acme',
    address: '1 Main St',
    city: 'NY',
    state: 'NY',
    postal_code: '1234',
    country: 'US',
    phone: '555',
    fax: '555',
    email: 'a@acme.com',
    website: 'acme.com',
    fiscal_information: 'VATFIXTURE',
    active: true,
    created_on: '2013-06-26T12:07:44Z',
    updated_on: '2014-08-04T12:12:13Z',
    image: 'http://x/logo.png',
    image_thumb_small: 'http://x/thumb.png',
  };

  assert.deepEqual(filterRecord(record, 'client', false), {
    id: 1234,
    name: 'Acme',
    address: '1 Main St',
    city: 'NY',
    state: 'NY',
    postal_code: '1234',
    country: 'US',
    phone: '555',
    fax: '555',
    email: 'a@acme.com',
    website: 'acme.com',
    fiscal_information: 'VATFIXTURE',
    active: true,
    created_on: '2013-06-26T12:07:44Z',
    updated_on: '2014-08-04T12:12:13Z',
  });
});

test('clientContact subset keeps the writable fields, notes included, and drops images and timestamps', () => {
  const record = {
    id: 1,
    client_id: 1234,
    name: 'Aaron Cooper',
    email: 'aaron@x.com',
    mobile: '555',
    phone: '556',
    fax: '557',
    skype: 'aaron.c',
    position: 'CEO',
    is_main: true,
    access: false,
    notes: 'prefers email',
    image: 'http://x/contact.jpg',
    image_thumb_medium: 'http://x/thumb.jpg',
    created_on: '2013-07-24T11:52:44Z',
    updated_on: '2014-08-13T13:00:24Z',
  };

  assert.deepEqual(filterRecord(record, 'clientContact', false), {
    id: 1,
    client_id: 1234,
    name: 'Aaron Cooper',
    email: 'aaron@x.com',
    mobile: '555',
    phone: '556',
    fax: '557',
    skype: 'aaron.c',
    position: 'CEO',
    is_main: true,
    access: false,
    notes: 'prefers email',
  });
});

test('company subset keeps the invoicing defaults and drops plan counters and images', () => {
  const record = {
    id: 1234,
    name: 'Gestazion',
    address: '1 Main St',
    phone: '555',
    email: 'dev@gestazion.com',
    url: 'gestazion.com',
    country: 'ES',
    fiscal_information: 'B-123',
    default_currency: 'EUR',
    default_price_per_hour: '30',
    default_tax: '21',
    default_tax_text: 'IVA',
    invoice_format: '#INV-[yyyy][mm][dd]-[i]',
    next_invoice_number: '101',
    date_format: 'd/m/Y',
    time_format: 'H:i',
    timezone: 'Europe/Madrid',
    account_type: 'commercial',
    max_users: 4,
    current_invoices: 0,
    image: 'http://x/logo.png',
  };

  assert.deepEqual(filterRecord(record, 'company', false), {
    id: 1234,
    name: 'Gestazion',
    address: '1 Main St',
    phone: '555',
    email: 'dev@gestazion.com',
    url: 'gestazion.com',
    country: 'ES',
    fiscal_information: 'B-123',
    default_currency: 'EUR',
    default_price_per_hour: '30',
    default_tax: '21',
    default_tax_text: 'IVA',
    invoice_format: '#INV-[yyyy][mm][dd]-[i]',
    next_invoice_number: '101',
    date_format: 'd/m/Y',
    time_format: 'H:i',
    timezone: 'Europe/Madrid',
  });
});

test('invoiceSummary is a strict subset of the invoice detail subset', () => {
  for (const key of SUBSETS.invoiceSummary) {
    assert.ok(SUBSETS.invoice.includes(key), `invoiceSummary field '${key}' is not in the invoice detail subset`);
  }

  assert.ok(SUBSETS.invoiceSummary.length < SUBSETS.invoice.length);
});

test('estimateSummary is a strict subset of the estimate detail subset', () => {
  for (const key of SUBSETS.estimateSummary) {
    assert.ok(SUBSETS.estimate.includes(key), `estimateSummary field '${key}' is not in the estimate detail subset`);
  }

  assert.ok(SUBSETS.estimateSummary.length < SUBSETS.estimate.length);
});

test('invoice subset keeps the money fields and line items and drops the download token and links', () => {
  const record = {
    id: 1234,
    number: '#1041',
    client_id: 5,
    status: 'paid',
    currency: 'EUR',
    date: '2026-01-01',
    due_date: '2026-02-01',
    subtotal: 80,
    total: 100,
    tax: 20,
    tax_amount: 20,
    invoiceitems: [{ id: 1, item: 'Logo', price_unit: 40, quantity: 2 }],
    download_token: 'secret-token',
    permalink: 'https://app.paymoapp.com/api/invoices/1234/?token=x',
    pdf_link: 'https://app.paymoapp.com/api/invoices/1234/?token=x&format=pdf',
    token: 'secret',
    reminders_sent: 2,
  };

  assert.deepEqual(filterRecord(record, 'invoice', false), {
    id: 1234,
    number: '#1041',
    client_id: 5,
    status: 'paid',
    currency: 'EUR',
    date: '2026-01-01',
    due_date: '2026-02-01',
    subtotal: 80,
    total: 100,
    tax: 20,
    tax_amount: 20,
    invoiceitems: [{ id: 1, item: 'Logo', price_unit: 40, quantity: 2 }],
  });
});

test('invoiceTemplate drops the html and css template bodies', () => {
  const template = {
    id: 1234,
    name: 'English - Client on right',
    title: 'INVOICE',
    is_default: true,
    html: '<div class="invoice">very long body</div>',
    css: '#invoice-title { color: #999; }',
    created_on: '2014-11-19T09:45:32Z',
  };

  assert.deepEqual(filterRecord(template, 'invoiceTemplate', false), {
    id: 1234,
    name: 'English - Client on right',
    title: 'INVOICE',
    is_default: true,
  });
});
