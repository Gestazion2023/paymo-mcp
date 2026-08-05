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
| `PAYMO_READ_ONLY` | no | `false` | Registers only the read tools. Accepts `1`/`true`/`yes`/`on` and their negatives. |

An unusable value in any of these aborts startup with an error instead of falling back to a default:
a `PAYMO_READ_ONLY` typo that silently granted write access would be worse than a server that
refuses to boot.

## Getting an API key

Your Paymo API key grants **full read and write access to your Paymo account**. Get it from your
Paymo account settings. Unless you need to create or mutate data, set `PAYMO_READ_ONLY=true` — an
accident with a write tool is much harder to undo than a wrong read.

## Tools

**Read (always available)**

| Tool | Args | Endpoint |
|---|---|---|
| `paymo_me` | — | `GET /me` |
| `paymo_list_projects` | `active?: boolean` (default true) | `GET /projects` |
| `paymo_list_tasklists` | `project_id?: number` | `GET /tasklists?where=project_id=…` |
| `paymo_list_tasks` | `project_id?: number`, `include_completed?: boolean` | `GET /tasks?where=…` |
| `paymo_get_task` | `task: string` (id or code) | `GET /tasks/{id}` |
| `paymo_list_workflow_statuses` | — | `GET /workflowstatuses` |
| `paymo_timer_status` | — | `GET /entries?where=end_time=null and user_id={me}` |

**Write (skipped when `PAYMO_READ_ONLY=true`)**

| Tool | Args | Endpoint |
|---|---|---|
| `paymo_create_task` | `name` (req), `project_id?`, `tasklist_id?`, `description?`, `due_date?`, `priority?`, `users?: number[]` | `POST /tasks` |
| `paymo_update_task` | `task` (req), plus any of `name`, `description`, `due_date`, `priority`, `users`, `complete`, `status` | `PUT /tasks/{id}` |
| `paymo_add_comment` | `task` (req), `content` (req) | `POST /comments` |
| `paymo_start_timer` | `task` (req) | `POST /entries` |
| `paymo_stop_timer` | — | `PUT /entries/{id}` |
| `paymo_delete_entry` | `entry_id` (req) | `DELETE /entries/{id}` |

A timer that ran for under a minute cannot be stopped: Paymo rejects an `end_time` that would make
the entry shorter than that. Delete it with `paymo_delete_entry` instead — that is the documented
way out, and the only reason this package ships a delete tool at all.

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