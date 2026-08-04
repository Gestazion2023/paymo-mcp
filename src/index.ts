#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { PaymoClient } from './client.ts';
import { StatusResolver } from './statuses.ts';
import { registerTools } from './tools.ts';

const apiKey = process.env.PAYMO_API_KEY ?? '';

if (apiKey === '') {
  console.error(
    'PAYMO_API_KEY is required. Get a Paymo API key from your Paymo account and set it in the environment.',
  );
  process.exit(1);
}

const baseUrl = process.env.PAYMO_BASE_URL ?? 'https://app.paymoapp.com/api';
const defaultProjectId = parseDefaultProjectId(process.env.PAYMO_DEFAULT_PROJECT_ID);
const readOnly = process.env.PAYMO_READ_ONLY === 'true';
const envAliases = parseStatusAliases(process.env.PAYMO_STATUS_ALIASES);

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const client = new PaymoClient({ apiKey, baseUrl });
const server = new McpServer({ name: 'paymo-mcp', version: packageJson.version });

registerTools(server, {
  client,
  resolver: new StatusResolver(envAliases),
  defaultProjectId,
  readOnly,
});

const transport = new StdioServerTransport();
await server.connect(transport);

function parseDefaultProjectId(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }

  const id = Number(raw);

  if (!Number.isInteger(id) || id <= 0) {
    console.error(`Invalid PAYMO_DEFAULT_PROJECT_ID: '${raw}'.`);
    process.exit(1);
  }

  return id;
}

function parseStatusAliases(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw === '') {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `Invalid PAYMO_STATUS_ALIASES (expected a JSON object like {"wip":123}): ${(err as Error).message}`,
    );
    process.exit(1);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('Invalid PAYMO_STATUS_ALIASES (expected a JSON object).');
    process.exit(1);
  }

  const aliases: Record<string, number> = {};

  for (const [key, value] of Object.entries(parsed)) {
    aliases[key] = Number(value);
  }

  return aliases;
}