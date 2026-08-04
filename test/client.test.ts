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