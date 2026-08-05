import { z } from 'zod';
import { filterRecord, paginate } from '../fields.ts';
import { limit, offset, respond, verbose } from './shared.ts';
import type { ToolDef } from './shared.ts';

// The invoice status machine, and the estimate one (adds accepted and invoiced).
const invoiceStatus = z
  .enum(['draft', 'sent', 'viewed', 'paid', 'void'])
  .describe('Invoice status to filter by.');
const estimateStatus = z
  .enum(['draft', 'sent', 'viewed', 'accepted', 'invoiced', 'void'])
  .describe('Estimate status to filter by.');

export const billingTools: Record<string, ToolDef> = {
  // Everything here is level 'read' on purpose: an invoice is a client-facing financial document
  // and a wrong write — a draft in an accounting export, a payment on the wrong invoice — is not
  // recoverable the way a wrong task status is. Invoicing writes were never a requirement; reading
  // state to answer "has this been paid" is. See section 19 of the plan.

  paymo_list_invoices: {
    level: 'read',
    description:
      'List Paymo invoices, optionally filtered by status or client. Call this to answer "has '
      + 'this been paid", to resolve an invoice_id, or to see what has been issued to a client.',
    inputSchema: {
      status: invoiceStatus.optional(),
      client_id: z.number().int().optional().describe('Restrict to invoices for one client.'),
      limit,
      offset,
      verbose,
    },
    handler: (args: {
      status?: string;
      client_id?: number;
      limit: number;
      offset: number;
      verbose: boolean;
    }, ctx) =>
      respond('list invoices', async () => {
        const records = await ctx.client.invoices(billingWhere(args.status, args.client_id));
        const filtered = records.map((record) => filterRecord(record, 'invoiceSummary', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_get_invoice: {
    level: 'read',
    description:
      'Fetch one Paymo invoice by id, including its line items (invoiceitems), totals and terms. '
      + 'Call this after listing to read the detail before answering how much was billed and '
      + 'whether it has been paid.',
    inputSchema: {
      invoice_id: z.number().int().describe('Paymo invoice id.'),
      verbose,
    },
    handler: (args: { invoice_id: number; verbose: boolean }, ctx) =>
      respond('get invoice', async () => {
        const record = await ctx.client.invoice(args.invoice_id);

        return filterRecord(record, 'invoice', args.verbose);
      }),
  },

  paymo_list_invoice_payments: {
    level: 'read',
    description:
      'List Paymo invoice payments, optionally for one invoice. Call this to answer what has '
      + 'actually been paid against an invoice, as opposed to what was invoiced.',
    inputSchema: {
      invoice_id: z.number().int().optional().describe('Restrict payments to a single invoice.'),
      limit,
      offset,
      verbose,
    },
    handler: (args: {
      invoice_id?: number;
      limit: number;
      offset: number;
      verbose: boolean;
    }, ctx) =>
      respond('list invoice payments', async () => {
        const records = await ctx.client.invoicePayments(args.invoice_id ?? null);
        const filtered = records.map((record) => filterRecord(record, 'invoicePayment', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_list_estimates: {
    level: 'read',
    description:
      'List Paymo estimates, optionally filtered by status or client. Call this while quoting a '
      + 'client or to see what proposals are outstanding.',
    inputSchema: {
      status: estimateStatus.optional(),
      client_id: z.number().int().optional().describe('Paymo client id to restrict the list to.'),
      limit,
      offset,
      verbose,
    },
    handler: (args: {
      status?: string;
      client_id?: number;
      limit: number;
      offset: number;
      verbose: boolean;
    }, ctx) =>
      respond('list estimates', async () => {
        const records = await ctx.client.estimates(billingWhere(args.status, args.client_id));
        const filtered = records.map((record) => filterRecord(record, 'estimateSummary', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },

  paymo_get_estimate: {
    level: 'read',
    description:
      'Fetch one Paymo estimate by id, including its line items (estimateitems), totals and '
      + 'whether it has been invoiced. Call this after listing to read the detail of a quote.',
    inputSchema: {
      estimate_id: z.number().int().describe('Paymo estimate id.'),
      verbose,
    },
    handler: (args: { estimate_id: number; verbose: boolean }, ctx) =>
      respond('get estimate', async () => {
        const record = await ctx.client.estimate(args.estimate_id);

        return filterRecord(record, 'estimate', args.verbose);
      }),
  },

  paymo_list_invoice_templates: {
    level: 'read',
    description:
      'List the Paymo invoice templates on the account — the layouts an invoice can be rendered '
      + 'in. Call this to answer "what invoice layouts exist", or to resolve a template_id.',
    inputSchema: { limit, offset, verbose },
    handler: (args: { limit: number; offset: number; verbose: boolean }, ctx) =>
      respond('list invoice templates', async () => {
        const records = await ctx.client.invoiceTemplates();
        const filtered = records.map((record) => filterRecord(record, 'invoiceTemplate', args.verbose));

        return paginate(filtered, args.limit, args.offset);
      }),
  },
};

/**
 * Builds the `where` clause shared by the invoice and estimate list tools from their optional
 * status and client_id filters. Paymo combines conditions with an `and` in the where mini-syntax.
 */
function billingWhere(status: string | undefined, clientId: number | undefined): string | undefined {
  const conditions: string[] = [];

  if (status !== undefined) {
    conditions.push(`status=${status}`);
  }

  if (clientId !== undefined) {
    conditions.push(`client_id=${clientId}`);
  }

  return conditions.length === 0 ? undefined : conditions.join(' and ');
}