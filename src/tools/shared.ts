import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PaymoClient } from '../client.ts';
import type { PermissionMode } from '../config.ts';
import type { StatusResolver } from '../statuses.ts';

export type ToolLevel = 'read' | 'write' | 'delete';

export interface ToolsContext {
  client: PaymoClient;
  resolver: StatusResolver;
  defaultProjectId: number | null;
  permissionMode: PermissionMode;
  /**
   * The tools actually registered, resolved once at startup and never changed mid-session. A tool
   * needs it to know what else the caller can do — e.g. `paymo_stop_timer` pointing at
   * `paymo_delete_entry` as the way out of the sub-minute rule only when that tool is registered.
   */
  registeredTools: ReadonlySet<string>;
}

/**
 * One entry in the flat `TOOLS` registry. Each tool's args are typed by its own zod schema, so
 * there is no single args signature — tool files annotate their handler's args concretely, and
 * the registration bridge in `index.ts` narrows the SDK callback through `never`. The return
 * type mirrors the SDK's `ToolCallback`, which accepts a plain `CallToolResult` (the direct
 * error returns in `paymo_create_task`) or a promise.
 */
export interface ToolDef {
  level: ToolLevel;
  description: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  handler: (args: never, ctx: ToolsContext) => CallToolResult | Promise<CallToolResult>;
}

export const taskIdentifier = z
  .string()
  .describe('Numeric task id (e.g. 1234) or human task code (e.g. ABC-1).');
export const projectId = z
  .number()
  .int()
  .describe('Paymo project id. When omitted, the configured default is used.');
export const statusArg = z
  .string()
  .describe('Numeric workflow status id or a slug alias (e.g. in_progress).');

export const PRIORITY = 'Priority: 100 critical, 75 high, 50 normal, 25 low. Paymo only uses these four.';

export const RICH_TEXT =
  'Paymo renders HTML here (p, b, i, u, s, ul, ol, li, h2, blockquote, a, br, code, pre, span) '
  + 'and strips anything else. Markdown is not rendered: use tags, not ** or backticks.';

/**
 * Bounded by default: a 90-task project answers with ~19 kB even after field filtering, and once
 * that lands in the conversation it is re-sent on every later turn. Raise it explicitly when you
 * genuinely need more, and page with `offset`.
 */
export const limit = z
  .number()
  .int()
  .min(1)
  .default(50)
  .describe(
    'Maximum number of records to return (default 50). Raise it when you need more, and use '
    + 'offset to page. Large listings are expensive: they stay in context for the rest of the '
    + 'conversation.',
  );
export const offset = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Number of records to skip before returning, for paging past the first page.');
export const verbose = z
  .boolean()
  .default(false)
  .describe(
    'When false (default) only the documented field subset is returned. Set true to return '
    + 'every field Paymo provides for each record.',
  );

export async function respond(context: string, fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return {
      content: [{ type: 'text', text: `Paymo ${context} failed: ${message}` }],
      isError: true,
    };
  }
}
