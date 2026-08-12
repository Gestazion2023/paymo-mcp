import type { PaymoRecord } from './client.ts';

/**
 * Documented field subsets for the list and detail tools. An agent needs an id, a name and a
 * code, not flat_billing or cover_file_id; Paymo answers with 20-40 fields per record and a
 * listing lands in the conversation verbatim, so dropping the noise is the biggest token win in
 * the package. Field names verified against the live API.
 */
export type RecordKind =
  | 'user'
  | 'project'
  | 'projectSummary'
  | 'task'
  | 'taskSummary'
  | 'tasklist'
  | 'comment'
  | 'workflowstatus'
  | 'entry'
  | 'projectTemplate'
  | 'projectStatus'
  | 'client'
  | 'clientSummary'
  | 'clientContact'
  | 'company'
  | 'invoice'
  | 'invoiceSummary'
  | 'invoicePayment'
  | 'estimate'
  | 'estimateSummary'
  | 'invoiceTemplate';

export const SUBSETS: Record<RecordKind, readonly string[]> = {
  user: [
    'id', 'name', 'email', 'type', 'active', 'timezone', 'position', 'language',
    'workday_hours', 'created_on', 'updated_on',
  ],
  project: [
    'id', 'name', 'code', 'description', 'client_id', 'client_name', 'workflow_id',
    'status_id', 'active', 'seq', 'budget_hours', 'billable', 'created_on', 'updated_on',
  ],
  // A listing exists to pick a record, a detail read to act on it. `projectSummary` is what a
  // caller needs to choose; the detail `project` subset above adds what acting needs.
  projectSummary: ['id', 'name', 'code', 'active', 'client_id', 'client_name'],
  // `users` is load-bearing, not informational: paymo_update_task replaces the assignee list
  // wholesale, so a caller that cannot see the current assignees will silently drop them when
  // adding one. Never remove it from this subset.
  task: [
    'id', 'name', 'code', 'project_id', 'tasklist_id', 'user_id', 'users', 'complete', 'status_id',
    'priority', 'due_date', 'start_date', 'description', 'seq', 'created_on', 'updated_on',
  ],
  // Same split as projects: a listing is for picking. `users` stays here for the same reason it
  // stays in `task` — dropping it recreates the assignee data-loss bug.
  taskSummary: [
    'id', 'name', 'code', 'project_id', 'tasklist_id', 'users', 'complete',
    'status_id', 'priority', 'due_date',
  ],
  tasklist: ['id', 'name', 'project_id', 'seq', 'milestone_id', 'tasks_count'],
  // Comments only have a listing here (no detail read), so this doubles as the detail subset. It
  // keeps the whole conversation shape: who wrote it (`user_id`), when (`created_on`), the body,
  // and the threading (`thread_id`, `reply_id`) a reader needs to follow a reply chain.
  // `edited_on` is here because paymo_update_comment exists: it is the only field separating a
  // comment as written from one rewritten afterwards, and a reader deciding whether to trust a
  // decision quoted from a comment needs to see that it was changed.
  // Verified with scripts/field-diff.mjs against a real task. The one field still dropped is
  // `options`, a notification envelope (`{"notification_to": []}`) that no reader and no write tool
  // consumes.
  comment: [
    'id', 'task_id', 'thread_id', 'reply_id', 'user_id', 'content', 'created_on', 'updated_on',
    'edited_on',
  ],
  workflowstatus: ['id', 'workflow_id', 'name', 'seq', 'action', 'color'],
  entry: [
    'id', 'task_id', 'user_id', 'project_id', 'start_time', 'end_time', 'duration',
    'description', 'billable',
  ],
  projectTemplate: ['id', 'name', 'description'],
  projectStatus: ['id', 'name', 'seq', 'active'],
  // The full client subset carries every field the write tools accept (the AGENTS.md rule: a
  // field paymo_update_client takes must be readable first) plus created/updated timestamps.
  // Dropped: image and image_thumb_* — logo URLs a model cannot render, presentation only, and
  // no write tool accepts them.
  client: [
    'id', 'name', 'address', 'city', 'state', 'postal_code', 'country', 'phone',
    'fax', 'email', 'website', 'fiscal_information', 'active', 'created_on', 'updated_on',
  ],
  // Same split as projects: a listing is for picking a client to attach to a project or invoice.
  clientSummary: ['id', 'name', 'email', 'country', 'active'],
  // Contacts only have a listing here (no detail read), so this doubles as the detail subset and
  // keeps every field the contact write tools accept — notes included, because it is writable.
  // Dropped: image/image_thumb_* (presentation) and created_on/updated_on (readonly timestamps).
  clientContact: [
    'id', 'client_id', 'name', 'email', 'mobile', 'phone', 'fax', 'skype',
    'position', 'is_main', 'access', 'notes',
  ],
  // Single-record read of the account's own identity and billing defaults; no company write tool,
  // so this is informational and biased toward what invoicing needs (identity, currency, number
  // format), dropping plan/subscription counters and presentation fields.
  company: [
    'id', 'name', 'address', 'phone', 'email', 'url', 'country', 'fiscal_information',
    'default_currency', 'default_price_per_hour', 'default_tax', 'default_tax_text',
    'invoice_format', 'next_invoice_number', 'date_format', 'time_format', 'timezone',
  ],
  // The billing toolset is read-only, so no write tool accepts any of these fields and there is no
  // update-replacement data-loss path. The detail read answers "what is this invoice, what was
  // billed, has it been paid"; the heavy dropped fields are the one-time download token and the
  // long signed permalink/pdf_link URLs that carry it — a credential-shaped string a model cannot
  // act on — plus the deprecated `language` and the reminder_* email-ops flags.
  invoice: [
    'id', 'number', 'client_id', 'template_id', 'status', 'currency', 'date', 'due_date',
    'subtotal', 'total', 'tax', 'tax2', 'tax_amount', 'tax2_amount', 'discount', 'discount_amount',
    'tax_on_tax', 'tax_text', 'tax2_text', 'discount_text', 'title', 'delivery_date',
    'pay_online', 'outstanding', 'bill_to', 'company_info', 'footer', 'notes',
    'created_on', 'updated_on', 'invoiceitems',
  ],
  // Same split as projects/clients: a listing is for picking. The plan fixes this exactly — enough
  // to choose an invoice, nothing more.
  invoiceSummary: ['id', 'number', 'client_id', 'status', 'date', 'due_date', 'total', 'currency'],
  // Payments only have a listing here (no detail read), so this doubles as the detail subset and
  // keeps every field — it is small and `amount`/`date`/`notes` are the whole point.
  invoicePayment: ['id', 'invoice_id', 'amount', 'date', 'notes', 'created_on', 'updated_on'],
  // Estimate detail mirrors invoice: same money fields, minus the invoice-only ones. Estimates
  // have no due_date or delivery_date; `invoice_id` links the estimate to the invoice created from
  // it. Dropped for the same reasons as invoice: download_token, signed permalink/pdf_link URLs,
  // deprecated `language`.
  estimate: [
    'id', 'number', 'client_id', 'template_id', 'status', 'currency', 'date',
    'subtotal', 'total', 'tax', 'tax2', 'tax_amount', 'tax2_amount', 'discount', 'discount_amount',
    'tax_on_tax', 'tax_text', 'tax2_text', 'discount_text', 'title', 'brief_description',
    'bill_to', 'company_info', 'footer', 'notes', 'invoice_id', 'created_on', 'updated_on',
    'estimateitems',
  ],
  estimateSummary: ['id', 'number', 'client_id', 'status', 'date', 'total', 'currency'],
  // Lookup tool for "what layouts exist" and to resolve a template_id. The `html` and `css`
  // template bodies are tens of kilobytes each — a listing carrying them would blow the context
  // for a question the model cannot act on (there is no write tool to edit a template).
  invoiceTemplate: ['id', 'name', 'title', 'is_default'],
};

/**
 * Returns the documented subset of a record, dropping every other field. Missing subset keys are
 * tolerated — a record that never had a `due_date` simply omits it. `verbose` returns the raw
 * record untouched.
 */
export function filterRecord(record: PaymoRecord, kind: RecordKind, verbose: boolean): PaymoRecord {
  if (verbose) {
    return record;
  }

  const subset = SUBSETS[kind];
  const out: PaymoRecord = {};

  for (const key of subset) {
    if (record[key] !== undefined) {
      out[key] = record[key];
    }
  }

  return out;
}

/**
 * Slices a record list to `limit` records starting at `offset`. An omitted `limit` returns
 * everything from `offset` on, matching the existing behaviour of returning full lists.
 */
export function paginate<T>(records: readonly T[], limit: number | undefined, offset: number): T[] {
  return records.slice(offset, limit === undefined ? undefined : offset + limit);
}
