import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymoHttpError } from '../src/client.ts';
import { respond } from '../src/tools.ts';

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