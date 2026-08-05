import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymoClient, PaymoHttpError } from '../src/client.ts';

function makeClient(handler: (url: string, init?: RequestInit) => Response): PaymoClient {
  return new PaymoClient({
    apiKey: 'test-key',
    baseUrl: 'https://app.paymoapp.com/api',
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
