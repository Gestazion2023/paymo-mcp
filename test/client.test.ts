import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { PaymoClient, PaymoHttpError } from '../src/client.ts';

function makeClient(handler: (url: string, init?: RequestInit) => Response): PaymoClient {
  return new PaymoClient({
    apiKey: 'test-key',
    baseUrl: 'https://app.paymoapp.com/api',
    uploadDir: tmpdir(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init)) as unknown as typeof fetch,
  });
}

test('resolveTaskId passes numeric ids through after trimming', async () => {
  const client = makeClient(() => new Response('{"tasks":[]}'));

  assert.equal(await client.resolveTaskId(' 123 '), 123);
  assert.equal(await client.resolveTaskId('0042'), 42);
});

test('resolveTaskId resolves a lowercased human code against an uppercased lookup', async () => {
  let requestedUrl = '';
  const client = makeClient((url) => {
    requestedUrl = url;
    return new Response('{"tasks":[{"id":42}]}');
  });

  assert.equal(await client.resolveTaskId('abc-1'), 42);
  assert.match(requestedUrl, /code%3DABC-1/);
});

test('resolveTaskId throws when the code is not found and exposes the uppercased lookup', async () => {
  let requestedUrl = '';
  const client = makeClient((url) => {
    requestedUrl = url;
    return new Response('{"tasks":[]}');
  });

  await assert.rejects(() => client.resolveTaskId('abc-99'), /Task code 'abc-99' not found/);
  assert.match(requestedUrl, /code%3DABC-99/);
});

test('resolveTaskId rejects a malformed code format', async () => {
  const client = makeClient(() => new Response('{"tasks":[]}'));

  await assert.rejects(() => client.resolveTaskId('bad code with spaces'), /Invalid task code format/);
});

test('task unwraps the singular object from the plural response key', async () => {
  const client = makeClient(() => new Response('{"tasks":[{"id":7,"name":"x"}]}'));

  assert.deepEqual(await client.task(7), { id: 7, name: 'x' });
});

test('task throws when the response array is empty', async () => {
  const client = makeClient(() => new Response('{"tasks":[]}'));

  await assert.rejects(() => client.task(7), /Task 7 not found/);
});

test('tasks builds a where clause and returns the list', async () => {
  let requestedUrl = '';
  const client = makeClient((url) => {
    requestedUrl = url;
    return new Response('{"tasks":[]}');
  });

  await client.tasks(5);
  assert.match(requestedUrl, /project_id%3D5/);
});

test('addComment sends a form-encoded request to /comments', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const client = makeClient((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response('{"comments":[{"id":1}]}');
  });

  await client.addComment(123, 'hello there');

  assert.equal(capturedUrl, 'https://app.paymoapp.com/api/comments');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(
    (capturedInit?.headers as Record<string, string>)['Content-Type'],
    'application/x-www-form-urlencoded',
  );
  assert.equal(capturedInit?.body, 'task_id=123&content=hello+there');
});

test('comments lists /comments filtered by task_id', async () => {
  let requestedUrl = '';
  const client = makeClient((url) => {
    requestedUrl = url;
    return new Response('{"comments":[{"id":1}]}');
  });

  assert.deepEqual(await client.comments(123), [{ id: 1 }]);
  assert.match(requestedUrl, /task_id%3D123/);
});

test('updateComment PUTs a form-encoded body to the comment and unwraps the record', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const client = makeClient((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response('{"comments":[{"id":21,"content":"fixed"}]}');
  });

  const updated = await client.updateComment(21, 'fixed');

  assert.equal(capturedUrl, 'https://app.paymoapp.com/api/comments/21');
  assert.equal(capturedInit?.method, 'PUT');
  assert.equal(
    (capturedInit?.headers as Record<string, string>)['Content-Type'],
    'application/x-www-form-urlencoded',
  );
  assert.equal(capturedInit?.body, 'content=fixed');
  assert.deepEqual(updated, { id: 21, content: 'fixed' });
});

test('updateComment throws when Paymo returns no comment', async () => {
  const client = makeClient(() => new Response('{"comments":[]}'));

  await assert.rejects(() => client.updateComment(21, 'fixed'), /Comment 21 update did not return/);
});

test('currentUserId resolves from the /me response and throws when missing', async () => {
  const ok = makeClient(() => new Response('{"users":[{"id":5}]}'));
  assert.equal(await ok.currentUserId(), 5);

  const empty = makeClient(() => new Response('{"users":[]}'));
  await assert.rejects(() => empty.currentUserId(), /Unable to resolve current Paymo user id/);
});

test('a non-2xx response throws PaymoHttpError carrying status and body', async () => {
  const client = makeClient(() => new Response('{"error":"unauthorized"}', { status: 401 }));

  let err: unknown;
  try {
    await client.me();
  } catch (caught) {
    err = caught;
  }

  assert.ok(err instanceof PaymoHttpError);
  assert.equal(err.status, 401);
  assert.match(err.message, /unauthorized/);
});
test('PaymoHttpError keeps the full body but truncates the message an LLM sees', () => {
  const html = `<!DOCTYPE html>\n<html>${'<div>blocked</div>'.repeat(500)}</html>`;
  const err = new PaymoHttpError(403, html);

  assert.equal(err.body, html);
  assert.ok(err.message.length < 500, `message was ${err.message.length} chars`);
  assert.match(err.message, /^Paymo API returned 403: /);
  assert.match(err.message, /chars truncated\)$/);
});

test('PaymoHttpError leaves a short json body intact', () => {
  const err = new PaymoHttpError(429, '{"message":"Too Many Requests"}');

  assert.equal(err.message, 'Paymo API returned 429: {"message":"Too Many Requests"}');
});

function makeRetryingClient(
  handler: (url: string, init?: RequestInit) => Response,
  slept: number[],
): PaymoClient {
  return new PaymoClient({
    apiKey: 'test-key',
    baseUrl: 'https://app.paymoapp.com/api',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init)) as unknown as typeof fetch,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  });
}

test('a 429 is retried once, waiting the decay period Paymo advertises', async () => {
  const slept: number[] = [];
  let calls = 0;
  const client = makeRetryingClient(() => {
    calls += 1;

    return calls === 1
      ? new Response('{"message":"Too Many Requests"}', {
        status: 429,
        headers: { 'X-Ratelimit-Decay-Period': '30' },
      })
      : new Response('{"tasks":[{"id":1}]}');
  }, slept);

  assert.deepEqual(await client.task(1), { id: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [30_000]);
});

test('a 429 without a usable decay header falls back to a default wait', async () => {
  const slept: number[] = [];
  const client = makeRetryingClient(
    () => new Response('{"message":"Too Many Requests"}', { status: 429 }),
    slept,
  );

  await assert.rejects(() => client.task(1), PaymoHttpError);
  assert.deepEqual(slept, [5_000]);
});

test('the retry wait is capped so a tool call cannot stall indefinitely', async () => {
  const slept: number[] = [];
  const client = makeRetryingClient(
    () => new Response('nope', { status: 429, headers: { 'X-Ratelimit-Decay-Period': '86400' } }),
    slept,
  );

  await assert.rejects(() => client.task(1), PaymoHttpError);
  assert.deepEqual(slept, [60_000]);
});

test('deleteEntry issues a DELETE and tolerates an empty body', async () => {
  let seen: { url: string; method?: string } | null = null;
  const client = makeClient((url, init) => {
    seen = { url, method: init?.method };

    return new Response(null, { status: 204 });
  });

  await client.deleteEntry(77);

  assert.deepEqual(seen, {
    url: 'https://app.paymoapp.com/api/entries/77',
    method: 'DELETE',
  });
});

test('generic list unwraps the plural key and returns an empty array when empty', async () => {
  let url = '';
  const client = makeClient((u) => {
    url = u;
    return new Response('{"projectstatuses":[]}');
  });

  assert.deepEqual(await client.list('projectstatuses', 'projectstatuses'), []);
  assert.equal(url, 'https://app.paymoapp.com/api/projectstatuses');
});

test('generic list appends a where clause when given one', async () => {
  let url = '';
  const client = makeClient((u) => {
    url = u;
    return new Response('{"projects":[{"id":5}]}');
  });

  assert.deepEqual(await client.list('projects', 'projects', 'active=true'), [{ id: 5 }]);
  assert.match(url, /where=active%3Dtrue/);
});

test('generic list reads the plural key even when it differs from the resource path', async () => {
  const client = makeClient(() => new Response('{"project_templates":[{"id":9}]}'));

  assert.deepEqual(await client.list('projecttemplates', 'project_templates'), [{ id: 9 }]);
});

test('generic one unwraps the first record and throws when the array is empty', async () => {
  const ok = makeClient(() => new Response('{"projects":[{"id":7,"name":"x"}]}'));
  assert.deepEqual(await ok.one('projects', 'projects', 7), { id: 7, name: 'x' });

  const empty = makeClient(() => new Response('{"projects":[]}'));
  await assert.rejects(() => empty.one('projects', 'projects', 7), /projects 7 not found/);
});

test('generic create and update POST/PUT JSON and unwrap the created record', async () => {
  const seen: { method?: string; body?: string }[] = [];
  const client = makeClient((_url, init) => {
    seen.push({ method: init?.method, body: init?.body });
    return new Response('{"projects":[{"id":1}]}');
  });

  assert.deepEqual(await client.create('projects', 'projects', { name: 'a' }), { id: 1 });
  assert.deepEqual(await client.update('projects', 'projects', 1, { active: false }), { id: 1 });

  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[0]?.body, '{"name":"a"}');
  assert.equal(seen[1]?.method, 'PUT');
  assert.equal(seen[1]?.body, '{"active":false}');
});

test('generic create throws when the response array is empty', async () => {
  const client = makeClient(() => new Response('{"projects":[]}'));

  await assert.rejects(() => client.create('projects', 'projects', { name: 'a' }), /created projects/);
});

test('clients builds a where clause for the requested active state', async () => {
  let url = '';
  const client = makeClient((u) => {
    url = u;
    return new Response('{"clients":[]}');
  });

  assert.deepEqual(await client.clients(true), []);
  assert.match(url, /where=active%3Dtrue/);
});

test('client and the client generics unwrap the plural clients key', async () => {
  const client = makeClient(() => new Response('{"clients":[{"id":7,"name":"Acme"}]}'));

  assert.deepEqual(await client.client(7), { id: 7, name: 'Acme' });
  assert.deepEqual(await client.createClient({ name: 'Globex' }), { id: 7, name: 'Acme' });
  assert.deepEqual(await client.updateClient(7, { active: false }), { id: 7, name: 'Acme' });
});

test('clientContacts filters by client_id when given and lists all otherwise', async () => {
  let url = '';
  const client = makeClient((u) => {
    url = u;
    return new Response('{"clientcontacts":[]}');
  });

  await client.clientContacts(1234);
  assert.match(url, /where=client_id%3D1234/);

  await client.clientContacts(null);
  assert.equal(url, 'https://app.paymoapp.com/api/clientcontacts');
});

test('client contact generics unwrap the clientcontacts key', async () => {
  const client = makeClient(() => new Response('{"clientcontacts":[{"id":3,"name":"Aaron"}]}'));

  assert.deepEqual(await client.createClientContact({ client_id: 1, name: 'Aaron' }), {
    id: 3,
    name: 'Aaron',
  });
  assert.deepEqual(await client.updateClientContact(3, { phone: '555' }), {
    id: 3,
    name: 'Aaron',
  });
});

test('company unwraps the singular company object and throws when missing', async () => {
  const ok = makeClient(() => new Response('{"company":{"id":5,"name":"Acme"}}'));
  assert.deepEqual(await ok.company(), { id: 5, name: 'Acme' });

  const empty = makeClient(() => new Response('{}'));
  await assert.rejects(() => empty.company(), /did not return a company record/);
});

test('invoices and estimates pass an optional where clause to their plural endpoints', async () => {
  let url = '';
  const client = makeClient((u) => {
    url = u;
    return new Response('{"invoices":[]}');
  });

  assert.deepEqual(await client.invoices('status=paid and client_id=5'), []);
  assert.match(url, /where=status%3Dpaid\+and\+client_id%3D5/);

  assert.deepEqual(await client.estimates(), []);
  assert.equal(url, 'https://app.paymoapp.com/api/estimates');
});

test('invoicePayments filters by invoice_id when given and lists all otherwise', async () => {
  let url = '';
  const client = makeClient((u) => {
    url = u;
    return new Response('{"invoicepayments":[]}');
  });

  await client.invoicePayments(9876);
  assert.match(url, /where=invoice_id%3D9876/);

  await client.invoicePayments(null);
  assert.equal(url, 'https://app.paymoapp.com/api/invoicepayments');
});

test('invoice and estimate detail reads ask for their line items and unwrap the record', async () => {
  let invoiceUrl = '';
  const client = makeClient((u) => {
    const route = invoiceUrl ? 'estimates' : 'invoices';
    invoiceUrl = u;

    return new Response(JSON.stringify({ [route]: [{ id: 7 }] }));
  });

  assert.deepEqual(await client.invoice(7), { id: 7 });
  assert.match(invoiceUrl, /\/invoices\/7\?include=invoiceitems/);

  assert.deepEqual(await client.estimate(7), { id: 7 });
  assert.match(invoiceUrl, /\/estimates\/7\?include=estimateitems/);
});

test('invoice throws when the record is missing and unwraps the invoices key', async () => {
  const ok = makeClient(() => new Response('{"invoices":[{"id":7}]}'));
  assert.deepEqual(await ok.invoice(7), { id: 7 });

  const empty = makeClient(() => new Response('{"invoices":[]}'));
  await assert.rejects(() => empty.invoice(7), /Invoice 7 not found/);
});

test('invoiceTemplates unwraps the invoicetemplates key', async () => {
  const client = makeClient(() => new Response('{"invoicetemplates":[{"id":1130,"name":"English - Client on right"}]}'));

  assert.deepEqual(await client.invoiceTemplates(), [
    { id: 1130, name: 'English - Client on right' },
  ]);
});

async function tempFile(name: string, content: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'paymo-mcp-')), name);

  await writeFile(path, content);

  return path;
}

test('uploadFile posts multipart with task_id and the file, leaving Content-Type to fetch', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const client = makeClient((url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response('{"files":[{"id":9,"task_id":123}]}');
  });

  const file = await client.uploadFile(123, await tempFile('data.csv', 'a,b\n1,2\n'));

  assert.deepEqual(file, { id: 9, task_id: 123 });
  assert.equal(capturedUrl, 'https://app.paymoapp.com/api/files');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(
    (capturedInit?.headers as Record<string, string>)['Content-Type'],
    undefined,
  );

  const form = capturedInit?.body as FormData;
  const sent = form.get('file') as File;

  assert.equal(form.get('task_id'), '123');
  assert.equal(sent.name, 'data.csv');
  assert.equal(await sent.text(), 'a,b\n1,2\n');
});

test('uploadFile rejects relative, missing, non-regular and empty paths before any request', async () => {
  const client = makeClient(() => {
    throw new Error('no request expected');
  });

  await assert.rejects(() => client.uploadFile(1, 'rel.csv'), /must be absolute/);
  await assert.rejects(() => client.uploadFile(1, '/nonexistent/x.csv'), /File not found/);
  await assert.rejects(() => client.uploadFile(1, tmpdir()), /Not a regular file/);
  const empty = await tempFile('e.csv', '');

  await assert.rejects(() => client.uploadFile(1, empty), /File is empty/);
});

test('uploadFile errors when Paymo returns no file', async () => {
  const client = makeClient(() => new Response('{"files":[]}'));

  await assert.rejects(
    async () => client.uploadFile(1, await tempFile('x.txt', 'x')),
    /did not return the uploaded file/,
  );
});

test('uploadFile is disabled without an upload directory', async () => {
  const client = new PaymoClient({ apiKey: 'k', baseUrl: 'https://x.test/api' });

  await assert.rejects(
    async () => client.uploadFile(1, await tempFile('a.txt', 'x')),
    /uploads are disabled/,
  );
});

test('uploadFile rejects files outside the upload directory, including via symlink and ..', async () => {
  const allowed = await mkdtemp(join(tmpdir(), 'paymo-allowed-'));
  const secret = await tempFile('secret.txt', 'top secret');
  const client = new PaymoClient({
    apiKey: 'k',
    baseUrl: 'https://x.test/api',
    uploadDir: allowed,
    fetch: (async () => {
      throw new Error('no request expected');
    }) as unknown as typeof fetch,
  });

  await symlink(secret, join(allowed, 'link.txt'));

  await assert.rejects(() => client.uploadFile(1, secret), /outside the allowed upload directory/);
  await assert.rejects(() => client.uploadFile(1, join(allowed, 'link.txt')), /outside the allowed/);
  await assert.rejects(
    () => client.uploadFile(1, join(allowed, '..', basename(secret))),
    /outside the allowed|File not found/,
  );
});

test('subtask methods hit /subtasks, not /tasks, and unwrap the plural key', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const client = makeClient((url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return new Response('{"subtasks":[{"id":7}]}');
  });

  assert.deepEqual(await client.subtasks(123), [{ id: 7 }]);
  assert.deepEqual(await client.createSubtask({ name: 'n', task_id: 123, project_id: 456 }), { id: 7 });
  assert.deepEqual(await client.updateSubtask(7, { complete: true }), { id: 7 });

  assert.match(calls[0]!.url, /\/subtasks\?where=task_id%3D123/);
  assert.equal(calls[1]!.method, 'POST');
  assert.match(calls[1]!.url, /\/subtasks$/);
  assert.equal(calls[2]!.method, 'PUT');
  assert.match(calls[2]!.url, /\/subtasks\/7$/);
});
