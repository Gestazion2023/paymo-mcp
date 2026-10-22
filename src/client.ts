import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';

export type PaymoRecord = Record<string, unknown>;

/**
 * Paymo documents no upload limit, so this is a conservative cap of our own: the file is read
 * into memory before sending, and an attachment this big is almost certainly a mistake.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MAX_ERROR_BODY = 400;

/**
 * The body is truncated because it reaches an LLM context verbatim: an API error is a
 * short JSON document, but a WAF or proxy in front of Paymo answers with a full HTML
 * page, and a few kilobytes of markup crowd out the conversation for no diagnostic gain.
 */
export class PaymoHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    const collapsed = body.replace(/\s+/g, ' ').trim();
    const summary = collapsed.length > MAX_ERROR_BODY
      ? `${collapsed.slice(0, MAX_ERROR_BODY)}… (${collapsed.length} chars truncated)`
      : collapsed;

    super(`Paymo API returned ${status}: ${summary}`);
    this.name = 'PaymoHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface PaymoClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Only files under this directory may be uploaded; null disables uploads. */
  uploadDir?: string | null;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Upper bound on how long a 429 is allowed to stall a tool call. */
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

interface RequestOptions {
  body?: PaymoRecord;
  form?: PaymoRecord;
  multipart?: FormData;
}

export class PaymoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly uploadDir: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    apiKey,
    baseUrl,
    uploadDir = null,
    fetch: fetchImpl = globalThis.fetch,
    sleep = (ms: number): Promise<void> => new Promise((resolve): void => {
      setTimeout(resolve, ms);
    }),
  }: PaymoClientOptions) {
    if (apiKey === '') {
      throw new Error('PAYMO_API_KEY is not configured.');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uploadDir = uploadDir;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async me(): Promise<PaymoRecord> {
    return this.request('GET', '/me');
  }

  async currentUserId(): Promise<number> {
    const { users } = await this.me() as { users?: PaymoRecord[] };
    const id = users?.[0]?.id;

    if (typeof id !== 'number') {
      throw new Error('Unable to resolve current Paymo user id.');
    }

    return id;
  }

  async task(id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/tasks/${id}`);
    const task = (payload.tasks as PaymoRecord[] | undefined)?.[0];

    if (task === undefined) {
      throw new Error(`Task ${id} not found.`);
    }

    return task;
  }

  async taskByCode(code: string): Promise<PaymoRecord | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(code)) {
      throw new Error(`Invalid task code format: '${code}'.`);
    }

    const payload = await this.request('GET', `/tasks?${this.query({ where: `code=${code}` })}`);
    return (payload.tasks as PaymoRecord[] | undefined)?.[0] ?? null;
  }

  async resolveTaskId(identifier: string): Promise<number> {
    const trimmed = identifier.trim();

    if (trimmed === '') {
      throw new Error('Task identifier cannot be empty.');
    }

    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    const task = await this.taskByCode(trimmed.toUpperCase());

    if (task === null) {
      throw new Error(`Task code '${trimmed}' not found.`);
    }

    if (typeof task.id !== 'number') {
      throw new Error(`Task code '${trimmed}' not found.`);
    }

    return task.id;
  }

  async tasks(projectId: number, onlyOpen = true): Promise<PaymoRecord[]> {
    let where = `project_id=${projectId}`;

    if (onlyOpen) {
      where += ' and complete=false';
    }

    const payload = await this.request('GET', `/tasks?${this.query({ where })}`);
    return (payload.tasks as PaymoRecord[] | undefined) ?? [];
  }

  async projects(active: boolean): Promise<PaymoRecord[]> {
    const payload = await this.request(
      'GET',
      `/projects?${this.query({ where: `active=${active ? 'true' : 'false'}` })}`,
    );

    return (payload.projects as PaymoRecord[] | undefined) ?? [];
  }

  async users(active: boolean): Promise<PaymoRecord[]> {
    return this.list('users', 'users', `active=${active ? 'true' : 'false'}`);
  }

  async tasklists(projectId: number | null): Promise<PaymoRecord[]> {
    const path = projectId === null
      ? '/tasklists'
      : `/tasklists?${this.query({ where: `project_id=${projectId}` })}`;

    const payload = await this.request('GET', path);
    return (payload.tasklists as PaymoRecord[] | undefined) ?? [];
  }

  async workflowStatuses(): Promise<PaymoRecord[]> {
    const payload = await this.request('GET', '/workflowstatuses');
    return (payload.workflowstatuses as PaymoRecord[] | undefined) ?? [];
  }

  async runningEntry(userId: number): Promise<PaymoRecord | null> {
    const payload = await this.request(
      'GET',
      `/entries?${this.query({ where: `end_time=null and user_id=${userId}` })}`,
    );

    return (payload.entries as PaymoRecord[] | undefined)?.[0] ?? null;
  }

  async createTask(data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('POST', '/tasks', { body: data });
    const task = (payload.tasks as PaymoRecord[] | undefined)?.[0];

    if (task === undefined) {
      throw new Error('Paymo did not return a created task.');
    }

    return task;
  }

  async updateTask(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/tasks/${id}`, { body: data });
    const task = (payload.tasks as PaymoRecord[] | undefined)?.[0];

    if (task === undefined) {
      throw new Error(`Task ${id} update did not return a task.`);
    }

    return task;
  }

  async addComment(taskId: number, content: string): Promise<PaymoRecord> {
    const payload = await this.request('POST', '/comments', {
      form: { task_id: taskId, content },
    });
    const comment = (payload.comments as PaymoRecord[] | undefined)?.[0];

    if (comment === undefined) {
      throw new Error(`Could not add comment to task ${taskId}.`);
    }

    return comment;
  }

  /**
   * Attaches a local file to a task. `/files` takes multipart/form-data with the numeric
   * `task_id` and the binary under `file`; the Content-Type header is left to fetch, which has to
   * generate the multipart boundary itself.
   */
  async uploadFile(taskId: number, path: string): Promise<PaymoRecord> {
    const real = await this.resolveUploadPath(path);
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const size = await this.assertUploadable(handle, path);
      const form = new FormData();

      form.set('task_id', String(taskId));
      form.set('file', new Blob([await handle.readFile()]), basename(real));

      const payload = await this.request('POST', '/files', { multipart: form });
      const file = (payload.files as PaymoRecord[] | undefined)?.[0];

      if (file === undefined) {
        throw new Error(`Paymo did not return the uploaded file (${size} bytes) for task ${taskId}.`);
      }

      return file;
    } finally {
      await handle.close();
    }
  }

  /**
   * Uploads read an arbitrary local file on behalf of the model, so they are confined to
   * PAYMO_UPLOAD_DIR: the path is resolved through symlinks first, then must sit inside the
   * (also resolved) directory. The file is then opened once with O_NOFOLLOW and every later
   * check and read goes through that descriptor, so it cannot be swapped after the check.
   */
  private async resolveUploadPath(path: string): Promise<string> {
    if (this.uploadDir === null) {
      throw new Error('File uploads are disabled: set PAYMO_UPLOAD_DIR to an allowed directory.');
    }

    if (!isAbsolute(path)) {
      throw new Error(`File path must be absolute: '${path}'.`);
    }

    const real = await realpath(path).catch(() => null);

    if (real === null) {
      throw new Error(`File not found: '${path}'.`);
    }

    const rel = relative(await realpath(this.uploadDir), real);

    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`File is outside the allowed upload directory: '${path}'.`);
    }

    return real;
  }

  private async assertUploadable(handle: FileHandle, path: string): Promise<number> {
    const info = await handle.stat();

    if (!info.isFile()) {
      throw new Error(`Not a regular file: '${path}'.`);
    }

    if (info.size === 0) {
      throw new Error(`File is empty: '${path}'.`);
    }

    if (info.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `File is ${info.size} bytes, over the ${MAX_UPLOAD_BYTES} byte (25 MiB) upload limit.`,
      );
    }

    return info.size;
  }

  /**
   * Edits a comment in place. Sent form-encoded for the same reason `addComment` is: `/comments`
   * is the one endpoint in this API that rejects a JSON body (see the API quirks in the plans).
   * Unverified live — the change that added it was not allowed to call the real API.
   */
  async updateComment(commentId: number, content: string): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/comments/${commentId}`, { form: { content } });
    const comment = (payload.comments as PaymoRecord[] | undefined)?.[0];

    if (comment === undefined) {
      throw new Error(`Comment ${commentId} update did not return a comment.`);
    }

    return comment;
  }

  /**
   * Comments are a resource of their own, not a field of the task, so reading a task's
   * conversation is a filtered listing rather than an `include` on the task read.
   */
  async comments(taskId: number): Promise<PaymoRecord[]> {
    return this.list('comments', 'comments', `task_id=${taskId}`);
  }

  /**
   * Subtasks live under `/subtasks`, not under `/tasks` with a parent: a task created with a
   * `parent_id` is just another root task. Verified by hand against the real API.
   */
  async subtasks(taskId: number): Promise<PaymoRecord[]> {
    return this.list('subtasks', 'subtasks', `task_id=${taskId}`);
  }

  async createSubtask(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('subtasks', 'subtasks', data);
  }

  async updateSubtask(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('subtasks', 'subtasks', id, data);
  }

  async startEntry(taskId: number): Promise<PaymoRecord> {
    const payload = await this.request('POST', '/entries', {
      body: {
        task_id: taskId,
        start_time: this.nowUtc(),
      },
    });
    const entry = (payload.entries as PaymoRecord[] | undefined)?.[0];

    if (entry === undefined) {
      throw new Error('Paymo did not return a created entry.');
    }

    return entry;
  }

  async stopEntry(entryId: number): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/entries/${entryId}`, {
      body: { end_time: this.nowUtc() },
    });
    const entry = (payload.entries as PaymoRecord[] | undefined)?.[0];

    if (entry === undefined) {
      throw new Error(`Entry ${entryId} update did not return an entry.`);
    }

    return entry;
  }

  private nowUtc(): string {
    return `${new Date().toISOString().slice(0, 19)}Z`;
  }

  private query(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  async deleteEntry(entryId: number): Promise<void> {
    await this.request('DELETE', `/entries/${entryId}`);
  }

  // --- Generic CRUD helpers ----------------------------------------------
  // Resource paths and the plural response keys they answer under do not always match
  // (`/projecttemplates` answers under `project_templates`, not `projecttemplates`), so each
  // caller passes its known key explicitly rather than trying to derive it.
  async list(resource: string, pluralKey: string, where?: string): Promise<PaymoRecord[]> {
    const path = where === undefined
      ? `/${resource}`
      : `/${resource}?${this.query({ where })}`;

    const payload = await this.request('GET', path);
    return (payload[pluralKey] as PaymoRecord[] | undefined) ?? [];
  }

  async one(resource: string, pluralKey: string, id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/${resource}/${id}`);
    const record = (payload[pluralKey] as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`${resource} ${id} not found.`);
    }

    return record;
  }

  async create(resource: string, pluralKey: string, data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('POST', `/${resource}`, { body: data });
    const record = (payload[pluralKey] as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`Paymo did not return a created ${resource} record.`);
    }

    return record;
  }

  async update(resource: string, pluralKey: string, id: number, data: PaymoRecord): Promise<PaymoRecord> {
    const payload = await this.request('PUT', `/${resource}/${id}`, { body: data });
    const record = (payload[pluralKey] as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`${resource} ${id} update did not return a record.`);
    }

    return record;
  }

  // --- Projects and tasklists --------------------------------------------
  async project(id: number): Promise<PaymoRecord> {
    return this.one('projects', 'projects', id);
  }

  async projectTemplates(): Promise<PaymoRecord[]> {
    return this.list('projecttemplates', 'project_templates');
  }

  async projectStatuses(): Promise<PaymoRecord[]> {
    return this.list('projectstatuses', 'projectstatuses');
  }

  async createProject(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('projects', 'projects', data);
  }

  async updateProject(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('projects', 'projects', id, data);
  }

  async createTasklist(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('tasklists', 'tasklists', data);
  }

  async updateTasklist(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('tasklists', 'tasklists', id, data);
  }

  // --- Clients, client contacts and company ------------------------------
  async clients(active: boolean): Promise<PaymoRecord[]> {
    return this.list('clients', 'clients', `active=${active ? 'true' : 'false'}`);
  }

  async client(id: number): Promise<PaymoRecord> {
    return this.one('clients', 'clients', id);
  }

  async createClient(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('clients', 'clients', data);
  }

  async updateClient(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('clients', 'clients', id, data);
  }

  async clientContacts(clientId: number | null): Promise<PaymoRecord[]> {
    return this.list(
      'clientcontacts',
      'clientcontacts',
      clientId === null ? undefined : `client_id=${clientId}`,
    );
  }

  async createClientContact(data: PaymoRecord): Promise<PaymoRecord> {
    return this.create('clientcontacts', 'clientcontacts', data);
  }

  async updateClientContact(id: number, data: PaymoRecord): Promise<PaymoRecord> {
    return this.update('clientcontacts', 'clientcontacts', id, data);
  }

  // --- Billing (invoices, invoice payments, estimates, invoice templates) ---
  async invoices(where?: string): Promise<PaymoRecord[]> {
    return this.list('invoices', 'invoices', where);
  }

  async invoicePayments(invoiceId: number | null): Promise<PaymoRecord[]> {
    return this.list(
      'invoicepayments',
      'invoicepayments',
      invoiceId === null ? undefined : `invoice_id=${invoiceId}`,
    );
  }

  async estimates(where?: string): Promise<PaymoRecord[]> {
    return this.list('estimates', 'estimates', where);
  }

  async invoiceTemplates(): Promise<PaymoRecord[]> {
    return this.list('invoicetemplates', 'invoicetemplates');
  }

  /**
   * The detail reads ride the generic `one` helper only as far as the resolves, but both need
   * `?include=…items` to return their line items — the plan's `paymo_get_invoice` and
   * `paymo_get_estimate` are explicitly "detail, including line items". `one` takes no query, so
   * these are hand-written.
   */
  async invoice(id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/invoices/${id}?include=invoiceitems`);
    const record = (payload.invoices as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`Invoice ${id} not found.`);
    }

    return record;
  }

  async estimate(id: number): Promise<PaymoRecord> {
    const payload = await this.request('GET', `/estimates/${id}?include=estimateitems`);
    const record = (payload.estimates as PaymoRecord[] | undefined)?.[0];

    if (record === undefined) {
      throw new Error(`Estimate ${id} not found.`);
    }

    return record;
  }

  /**
   * `company` is the one record returned as a single object (`{"company":{…}}`) rather than
   * wrapped in an array like every other record, so it cannot ride the generic helpers.
   */
  async company(): Promise<PaymoRecord> {
    const payload = await this.request('GET', '/company');
    const record = payload.company as PaymoRecord | undefined;

    if (record === undefined) {
      throw new Error('Paymo did not return a company record.');
    }

    return record;
  }

  /**
   * Paymo advertises the window it wants us to wait through `X-Ratelimit-Decay-Period`,
   * so honour that rather than guessing a backoff curve.
   */
  private retryDelayMs(response: Response): number {
    const seconds = Number(response.headers.get('x-ratelimit-decay-period'));
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_DELAY_MS;

    return Math.min(delay, MAX_RETRY_DELAY_MS);
  }

  private async request(
    method: string,
    path: string,
    options: RequestOptions = {},
    isRetry = false,
  ): Promise<PaymoRecord> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:X`).toString('base64')}`,
      Accept: 'application/json',
    };

    let body: string | FormData | undefined;

    if (options.multipart !== undefined) {
      body = options.multipart;
    } else if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(
        Object.entries(options.form).map(([key, value]) => [key, String(value)] as [string, string]),
      ).toString();
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let response: Response;

    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429 && !isRetry) {
      await this.sleep(this.retryDelayMs(response));

      return this.request(method, path, options, true);
    }

    if (!response.ok) {
      throw new PaymoHttpError(response.status, await response.text());
    }

    const text = await response.text();

    if (text === '') {
      return {};
    }

    return JSON.parse(text) as PaymoRecord;
  }
}
