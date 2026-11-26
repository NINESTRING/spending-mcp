import { date, index, integer, pgTable, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const transactions = pgTable(
  'transactions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    // Whose spending it is: the token's subject over HTTP, SPENDING_OWNER over stdio.
    ownerId: text('owner_id').notNull(),
    // The day of the purchase, as the statement prints it: a calendar day, no time zone.
    spentOn: date('spent_on', { mode: 'string' }).notNull(),
    // The merchant as the statement names it, and the normalized form categories are keyed by.
    merchant: text('merchant').notNull(),
    merchantKey: text('merchant_key').notNull(),
    // Won, without decimals. Negative for a cancellation or a refund.
    amount: integer('amount').notNull(),
    category: text('category').notNull(),
    // A label for the card, such as its last four digits. Never the full number.
    card: text('card'),
    approvalNo: text('approval_no'),
    memo: text('memo'),
    // What makes a statement line the same line when it is imported again.
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('transactions_owner_id_dedupe_key_unique').on(table.ownerId, table.dedupeKey),
    // Every query starts with the owner, and most of them with a range of days.
    index('transactions_owner_id_spent_on_idx').on(table.ownerId, table.spentOn),
    index('transactions_owner_id_merchant_key_idx').on(table.ownerId, table.merchantKey),
  ],
);

/** The category each merchant was first filed under, so the same merchant is the same category every month. */
export const merchantCategories = pgTable(
  'merchant_categories',
  {
    ownerId: text('owner_id').notNull(),
    merchantKey: text('merchant_key').notNull(),
    category: text('category').notNull(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.merchantKey] })],
);

export type Transaction = typeof transactions.$inferSelect;
