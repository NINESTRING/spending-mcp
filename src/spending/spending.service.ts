import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gte, ilike, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { merchantCategories, transactions } from '../database/schema.js';
import type { Category } from './categories.js';

export interface NewTransaction {
  date: string;
  merchant: string;
  amount: number;
  category: Category;
  card?: string;
  approvalNo?: string;
  memo?: string;
}

export interface SearchTransactionsQuery {
  from?: string;
  to?: string;
  text?: string;
  category?: Category;
  limit: number;
}

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}

const total = sql<number>`coalesce(sum(${transactions.amount}), 0)`.mapWith(Number);
const count = sql<number>`count(*)`.mapWith(Number);

/** Every method takes the owner, and never reads or changes another owner's transactions. */
@Injectable()
export class SpendingService {
  constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

  /**
   * Stores a statement's lines. A line that is already stored is skipped, so importing the same
   * statement twice adds nothing. A merchant filed before keeps its category, whatever the line says.
   */
  import(owner: string, rows: NewTransaction[]) {
    return this.db.transaction(async (tx) => {
      const keys = [...new Set(rows.map((row) => merchantKeyOf(row.merchant)))];
      const known = await tx
        .select({ merchantKey: merchantCategories.merchantKey, category: merchantCategories.category })
        .from(merchantCategories)
        .where(and(eq(merchantCategories.ownerId, owner), inArray(merchantCategories.merchantKey, keys)));
      const filed = new Map(known.map((row) => [row.merchantKey, row.category]));
      const firstSeen = new Map<string, string>();
      const recategorized = new Map<string, { merchant: string; from: string; to: string }>();
      const occurrences = new Map<string, number>();

      const values = rows.map((row) => {
        const merchantKey = merchantKeyOf(row.merchant);
        const kept = filed.get(merchantKey) ?? firstSeen.get(merchantKey);
        if (!kept) {
          firstSeen.set(merchantKey, row.category);
        } else if (kept !== row.category) {
          recategorized.set(merchantKey, { merchant: row.merchant, from: row.category, to: kept });
        }
        // Two coffees at the same place on the same day are two lines: the second is occurrence 2,
        // in this import and in every later import of the same statement.
        const line = row.approvalNo
          ? `approval:${row.card ?? ''}:${row.approvalNo}:${row.amount}`
          : `line:${row.date}:${row.amount}:${merchantKey}:${row.card ?? ''}`;
        const occurrence = (occurrences.get(line) ?? 0) + 1;
        occurrences.set(line, occurrence);
        return {
          ownerId: owner,
          spentOn: row.date,
          merchant: row.merchant,
          merchantKey,
          amount: row.amount,
          category: kept ?? row.category,
          card: row.card,
          approvalNo: row.approvalNo,
          memo: row.memo,
          dedupeKey: `${line}#${occurrence}`,
        };
      });

      const inserted = await tx
        .insert(transactions)
        .values(values)
        .onConflictDoNothing({ target: [transactions.ownerId, transactions.dedupeKey] })
        .returning({ id: transactions.id });
      if (firstSeen.size > 0) {
        await tx
          .insert(merchantCategories)
          .values([...firstSeen].map(([merchantKey, category]) => ({ ownerId: owner, merchantKey, category })))
          .onConflictDoNothing();
      }
      return {
        received: rows.length,
        inserted: inserted.length,
        duplicates: rows.length - inserted.length,
        recategorized: [...recategorized.values()],
      };
    });
  }

  search(owner: string, { from, to, text, category, limit }: SearchTransactionsQuery) {
    const conditions: SQL[] = [eq(transactions.ownerId, owner)];
    if (from) conditions.push(gte(transactions.spentOn, from));
    if (to) conditions.push(lte(transactions.spentOn, to));
    if (category) conditions.push(eq(transactions.category, category));
    if (text) {
      // The text is matched literally: % and _ in it are not wildcards.
      conditions.push(ilike(transactions.merchant, `%${text.replace(/[\\%_]/g, '\\$&')}%`));
    }
    return this.db
      .select({
        id: transactions.id,
        date: transactions.spentOn,
        merchant: transactions.merchant,
        amount: transactions.amount,
        category: transactions.category,
        card: transactions.card,
        memo: transactions.memo,
      })
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.spentOn), desc(transactions.id))
      .limit(limit);
  }

  /** A month's total, its categories and its ten largest merchants. The sums are PostgreSQL's. */
  async summarize(owner: string, month: string) {
    const inMonth = this.inMonth(owner, month);
    const [overall] = await this.db.select({ total, count }).from(transactions).where(inMonth);
    const topMerchants = await this.db
      // One row per merchant, however its name was spaced or cased on each statement.
      .select({ merchant: sql<string>`min(${transactions.merchant})`, total, count })
      .from(transactions)
      .where(inMonth)
      .groupBy(transactions.merchantKey)
      .orderBy(desc(total))
      .limit(10);
    return {
      month,
      total: overall.total,
      count: overall.count,
      byCategory: await this.byCategory(owner, month),
      topMerchants,
    };
  }

  /** Each category in `month` against `baseMonth`, the largest increase first. */
  async compare(owner: string, month: string, baseMonth: string) {
    const [current, base] = await Promise.all([this.byCategory(owner, month), this.byCategory(owner, baseMonth)]);
    const before = new Map(base.map((row) => [row.category, row.total]));
    const now = new Map(current.map((row) => [row.category, row.total]));
    const categories = [...new Set([...now.keys(), ...before.keys()])].map((category) => {
      const totalNow = now.get(category) ?? 0;
      const totalBefore = before.get(category) ?? 0;
      return { category, total: totalNow, baseTotal: totalBefore, difference: totalNow - totalBefore };
    });
    categories.sort((a, b) => b.difference - a.difference);
    const sum = (rows: CategoryTotal[]) => rows.reduce((acc, row) => acc + row.total, 0);
    return {
      month,
      baseMonth,
      total: sum(current),
      baseTotal: sum(base),
      difference: sum(current) - sum(base),
      categories,
    };
  }

  /** Files a merchant under a category from now on, and refiles what was already imported. */
  setMerchantCategory(owner: string, merchant: string, category: Category) {
    const merchantKey = merchantKeyOf(merchant);
    return this.db.transaction(async (tx) => {
      await tx
        .insert(merchantCategories)
        .values({ ownerId: owner, merchantKey, category })
        .onConflictDoUpdate({
          target: [merchantCategories.ownerId, merchantCategories.merchantKey],
          set: { category, updatedAt: new Date() },
        });
      const updated = await tx
        .update(transactions)
        .set({ category })
        .where(and(eq(transactions.ownerId, owner), eq(transactions.merchantKey, merchantKey)))
        .returning({ id: transactions.id });
      return { merchant, category, updatedTransactions: updated.length };
    });
  }

  private byCategory(owner: string, month: string): Promise<CategoryTotal[]> {
    return this.db
      .select({ category: transactions.category, total, count })
      .from(transactions)
      .where(this.inMonth(owner, month))
      .groupBy(transactions.category)
      .orderBy(desc(total));
  }

  private inMonth(owner: string, month: string) {
    return and(
      eq(transactions.ownerId, owner),
      gte(transactions.spentOn, `${month}-01`),
      lt(transactions.spentOn, `${shiftMonth(month, 1)}-01`),
    );
  }
}

/** "스타벅스 강남점 " and "스타벅스  강남점" are one merchant. */
function merchantKeyOf(merchant: string): string {
  return merchant.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** `2026-01` shifted by -1 is `2025-12`. */
export function shiftMonth(month: string, by: number): string {
  const [year, monthOfYear] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthOfYear - 1 + by, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}
