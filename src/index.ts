#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { PaymoClient } from './client.ts';
import { ConfigError, loadConfig } from './config.ts';
import { StatusResolver } from './statuses.ts';
import { registerTools } from './tools/index.ts';

let config;

try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }

  throw err;
}

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const server = new McpServer({ name: 'paymo-mcp', version: packageJson.version });

registerTools(server, {
  client: new PaymoClient({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
  resolver: new StatusResolver(config.statusAliases),
  defaultProjectId: config.defaultProjectId,
  readOnly: config.readOnly,
});

await server.connect(new StdioServerTransport());