#!/usr/bin/env node
// Diffs a tool's filtered response against its verbose one and prints the dropped fields.
// Every dropped field is a deliberate choice: a field an agent needs but cannot see produces
// silent wrong behaviour, not an error. See AGENTS.md § "Changing fields.ts".
//
//   node scripts/field-diff.mjs paymo_get_task '{"task":"ABC-1"}'
//   node scripts/field-diff.mjs paymo_list_projects
//
// Requires PAYMO_API_KEY. Reads only — never pass a tool that writes.

import { spawn } from 'node:child_process';

const [tool, rawArgs = '{}'] = process.argv.slice(2);

if (tool === undefined) {
  console.error('usage: node scripts/field-diff.mjs <tool_name> [json-args]');
  process.exit(1);
}

async function call(args) {
  const child = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PAYMO_READ_ONLY: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

  child.stdin.write(`${request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'field-diff', version: '1' },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${request(2, 'tools/call', { name: tool, arguments: args })}\n`);
  child.stdin.end();

  let out = '';
  for await (const chunk of child.stdout) {
    out += chunk;
  }

  const last = out.trim().split('\n').at(-1);
  const result = JSON.parse(last).result;

  if (result.isError) {
    throw new Error(result.content[0].text);
  }

  const payload = JSON.parse(result.content[0].text);
  return Array.isArray(payload) ? payload[0] : (payload.running ?? payload);
}

const args = JSON.parse(rawArgs);
const filtered = await call(args);
await new Promise((resolve) => setTimeout(resolve, 22_000)); // Paymo rate-limits hard
const verbose = await call({ ...args, verbose: true });

const kept = Object.keys(filtered ?? {}).sort();
const all = Object.keys(verbose ?? {}).sort();
const dropped = all.filter((key) => !kept.includes(key));

console.log(`\n${tool}`);
console.log(`  kept    (${kept.length}): ${kept.join(' ')}`);
console.log(`  dropped (${dropped.length}): ${dropped.join(' ') || '—'}`);
console.log('\nJustify every dropped field before committing. A field the model needs but cannot');
console.log('see fails silently — no error, no test failure, wrong behaviour.\n');