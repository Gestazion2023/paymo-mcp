# paymo-mcp

An unofficial Model Context Protocol (MCP) server for the **Paymo** time-tracking API. Read and
write Paymo tasks, workflow statuses and time entries from any MCP client with `npx`.
Not affiliated with Paymo — no warranty and no endorsement.

## Install

No install needed. Any MCP client can launch it with `npx -y paymo-mcp` into any project that has
a Paymo API key. Example `.mcp.json`:

```json
{
  "mcpServers": {
    "paymo": {
      "command": "npx",
      "args": ["-y", "paymo-mcp"],
      "env": {
        "PAYMO_API_KEY": "your-key-here"
      }
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "paymo": {
      "command": "npx",
      "args": ["-y", "paymo-mcp"],
      "env": {
        "PAYMO_API_KEY": "your-key-here"
      }
    }
  }
}
```

## Configuration

Environment variables read by `paymo-mcp`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PAYMO_API_KEY` | yes | — | Paymo API key used with HTTP Basic auth. |
| `PAYMO_BASE_URL` | no | `https://app.paymoapp.com/api` | API base URL. |
| `PAYMO_DEFAULT_PROJECT_ID` | no | — | Project used when a project id argument is omitted. |
| `PAYMO_STATUS_ALIASES` | no | discovered automatically | JSON object overriding status aliases, e.g. `{"wip":123,"done":456}`. Keys are slugified, values must be positive integers. |
| `PAYMO_TOOLSETS` | no | `default` | Comma-separated toolset names, plus the keywords `default` and `all`. Case-insensitive and whitespace-tolerant. |
| `PAYMO_TOOLS` | no | — | Comma-separated tool names, additive on top of the toolsets. Matched exactly as registered. |
| `PAYMO_DENIED_TOOLS_REGEX` | no | — | One JS regex, matched against tool names and subtracted from the resolved set last. |
| `PAYMO_PERMISSION_MODE` | no | `modify` | One of `readonly`, `modify`, `full` — see below. |
| `PAYMO_READ_ONLY` | no | — | **Deprecated.** Use `PAYMO_PERMISSION_MODE`. `true` maps to `readonly`, `false` to `modify`. |

An unusable value in any of these aborts startup with an error instead of falling back to a default:
a typo that silently granted write access would be worse than a server that refuses to boot. Setting
both `PAYMO_PERMISSION_MODE` and `PAYMO_READ_ONLY` also aborts — drop the deprecated one rather than
guessing which variable won.

### Toolsets

| Toolset | Covers | Tools |
|---|---|---|
| `context` | `paymo_me`, `paymo_list_workflow_statuses` — who am I, what statuses exist | 2 |
| `tasks` | tasks, tasklists (read), comments, subtasks | 7 |
| `time` | time entries: timer control, manual logging, deletion | 4 |
| `all` | every toolset above | 13 |

`default` = `context` + `tasks` + `time`, which is approximately the surface the package exposed
before toolsets existed — an existing user upgrading sees no change. Names are additive and
order-independent, so `PAYMO_TOOLSETS=default,billing` would mean defaults *plus* billing.

### How the tool set is resolved

1. `PAYMO_TOOLSETS` expands to a set of tool names (`default` → the default toolsets; `all` → every
   toolset; names are additive).
2. `PAYMO_TOOLS` is unioned in.
3. `PAYMO_DENIED_TOOLS_REGEX` is subtracted.
4. `PAYMO_PERMISSION_MODE` filters last — never overridable by naming a tool explicitly.

The resolved set is fixed at startup and never changes mid-session. Changing any of these variables
requires restarting the MCP client; a fixed `tools` array is what keeps the prompt cache valid.

### Permission modes

| Mode | Registers |
|---|---|
| `readonly` | reads only |
| `modify` | reads + create/update; **all delete tools omitted** |
| `full` | everything, deletes included |

`modify` is the default: an MCP server handing a model an API key with full account access should not
delete by default. `paymo_delete_entry` is the only delete tool, and it exists because Paymo refuses
to set an `end_time` on an entry under a minute old — such a timer can only be closed by deleting it.
It therefore requires `PAYMO_PERMISSION_MODE=full`; under `modify`, `paymo_stop_timer`'s error names
that requirement instead of leaving you at a dead end.

### Examples

Defaults — read and write, no deletes:

```json
{
  "mcpServers": {
    "paymo": {
      "command": "npx",
      "args": ["-y", "paymo-mcp"],
      "env": {
        "PAYMO_API_KEY": "your-key-here"
      }
    }
  }
}
```

A single toolset — just identity and workflow statuses:

```json
{
  "mcpServers": {
    "paymo": {
      "command": "npx",
      "args": ["-y", "paymo-mcp"],
      "env": {
        "PAYMO_API_KEY": "your-key-here",
        "PAYMO_TOOLSETS": "context"
      }
    }
  }
}
```

A single-tool allowlist — the context toolset plus exactly one write tool:

```json
{
  "mcpServers": {
    "paymo": {
      "command": "npx",
      "args": ["-y", "paymo-mcp"],
      "env": {
        "PAYMO_API_KEY": "your-key-here",
        "PAYMO_TOOLSETS": "context",
        "PAYMO_TOOLS": "paymo_create_task"
      }
    }
  }
}
```

## Getting an API key

Your Paymo API key grants **full read and write access to your Paymo account**. Get it from your
Paymo account settings. Unless you need to create or mutate data, set `PAYMO_PERMISSION_MODE=readonly`
— an accident with a write tool is much harder to undo than a wrong read.

## Tools

**Read** — registered in every permission mode, subject to the selected toolsets.

| Tool | Args | Endpoint |
|---|---|---|
| `paymo_me` | `verbose?` | `GET /me` |
| `paymo_list_projects` | `active?: boolean` (default true), `limit?`, `offset?`, `verbose?` | `GET /projects` |
| `paymo_list_tasklists` | `project_id?: number`, `limit?`, `offset?`, `verbose?` | `GET /tasklists?where=project_id=…` |
| `paymo_list_tasks` | `project_id?: number`, `include_completed?: boolean`, `limit?`, `offset?`, `verbose?` | `GET /tasks?where=…` |
| `paymo_get_task` | `task: string` (id or code), `verbose?` | `GET /tasks/{id}` |
| `paymo_list_workflow_statuses` | `limit?`, `offset?`, `verbose?` | `GET /workflowstatuses` |
| `paymo_timer_status` | `verbose?` | `GET /entries?where=end_time=null and user_id={me}` |

**Write** — registered under `modify` and `full`.

| Tool | Args | Endpoint |
|---|---|---|
| `paymo_create_task` | `name` (req), `project_id?`, `tasklist_id?`, `description?`, `due_date?`, `priority?`, `users?: number[]` | `POST /tasks` |
| `paymo_update_task` | `task` (req), plus any of `name`, `description`, `due_date`, `priority`, `users`, `complete`, `status` | `PUT /tasks/{id}` |
| `paymo_add_comment` | `task` (req), `content` (req) | `POST /comments` |
| `paymo_start_timer` | `task` (req) | `POST /entries` |
| `paymo_stop_timer` | — | `PUT /entries/{id}` |

**Delete** — registered under `full` only.

| Tool | Args | Endpoint |
|---|---|---|
| `paymo_delete_entry` | `entry_id` (req) | `DELETE /entries/{id}` |

A timer that ran for under a minute cannot be stopped: Paymo rejects an `end_time` that would make
the entry shorter than that. Delete it with `paymo_delete_entry` instead — that is the documented
way out, and the only reason this package ships a delete tool at all. Because `full` is not the
default, the stop error names that requirement when the tool is not registered.

### Response size

Paymo answers with 20–40 fields per record; a project listing comes back several times larger than
the whole tool catalogue. The list and detail tools therefore return a **documented field subset** —
an agent needs `id`, `name`, `code`, not `flat_billing` or `cover_file_id`. List tools take
`limit` (**default 50**) and `offset` for paging, and return a **narrower summary subset** than
detail reads: a
listing exists to pick a record, so it carries `id`/`name`/`code` and the couple of fields needed to
choose, while `paymo_get_task` and `paymo_me` keep the fuller set. Pass `verbose: true` to any read
tool when you genuinely need every field Paymo provides — it bypasses both subsets.

### Rate limiting

Paymo answers a 429 with `X-Ratelimit-Decay-Period`, and a request that hits one is retried once
after waiting exactly that long (capped at 60s) before the error surfaces. Bursts still hurt: a
single tool call can cost two or three requests, since resolving a task code and the current user
are separate lookups.

Where a `task` is expected, pass either a numeric **id** or a human **task code** (e.g. `ABC-1`).
Where a `status` is expected, pass a numeric id or a slug alias such as `in_progress`; aliases are
discovered from your workflow, overridable with `PAYMO_STATUS_ALIASES`.

### Rich text

Task descriptions and comments accept HTML. Paymo keeps `p`, `b`, `i`, `u`, `s`, `ul`, `ol`, `li`,
`h2`, `blockquote`, `a`, `br`, `code`, `pre` and `span` (including inline `style`), adds
`rel="noopener noreferrer"` to links, and strips everything else — `<script>` included. Markdown is
**not** rendered: `**bold**` stays literal and backticks come back HTML-escaped, so use tags.

Note that a WAF sits in front of the Paymo API and can reject a request whose body merely *looks*
dangerous. Posting a comment containing `<script>` returns a 403 HTML page rather than a Paymo
error, even though Paymo itself would have stripped the tag.

## Development

```sh
npm test        # node --test, no framework
npm run build   # tsc to dist/
```

## License

MIT — see [LICENSE](LICENSE).