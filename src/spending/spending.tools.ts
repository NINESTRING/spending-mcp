import { Injectable } from '@nestjs/common';
import { Prompt, Tool, type McpContext } from '@nestjs/mcp';
import type { PromptMessage } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CATEGORIES } from './categories.js';
import { CurrentOwner, type Owner } from './owner.decorator.js';
import { shiftMonth, SpendingService } from './spending.service.js';

const category = z.enum(CATEGORIES);
const day = z.iso.date().describe('A calendar day as YYYY-MM-DD, such as 2026-11-03');
const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe('A month as YYYY-MM, such as 2026-11');
const merchant = z.string().trim().min(1).max(200);

const transactionSchema = z.object({
  date: day,
  merchant: merchant.describe('The merchant exactly as the statement prints it, such as "스타벅스 강남점"'),
  // The database's integer range is larger; no card statement line is.
  amount: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .describe('Won, without decimals: 4500 for a purchase, -4500 for its cancellation or a refund'),
  category: category.describe(
    'Your best category for the merchant. A merchant imported before keeps the category it already has',
  ),
  card: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe('A label for the card, such as "신한 1234": the issuer and the last four digits, never the full number'),
  approvalNo: z.string().trim().min(1).max(40).optional().describe('The approval number, when the statement has one'),
  memo: z.string().trim().max(200).optional().describe('Anything else worth keeping, such as "3개월 할부"'),
});

const importTransactionsSchema = z.object({
  transactions: z
    .array(transactionSchema)
    .min(1)
    .max(200)
    .describe('Every line of the statement, in its order. Call again with the next 200 for a longer one'),
});

const searchTransactionsSchema = z.object({
  from: day.optional().describe('The first day to include, as YYYY-MM-DD'),
  to: day.optional().describe('The last day to include, as YYYY-MM-DD'),
  text: z.string().trim().min(1).max(100).optional().describe('Words to find in the merchant, such as "스타벅스"'),
  category: category.optional().describe('Only transactions in this category'),
  limit: z.number().int().min(1).max(200).default(50).describe('How many transactions to return, newest first'),
});

const summarizeSpendingSchema = z.object({ month });

const compareMonthsSchema = z.object({
  month,
  baseMonth: month.optional().describe('The month to compare with, as YYYY-MM. Leave it out for the month before'),
});

const setMerchantCategorySchema = z.object({
  merchant: merchant.describe('The merchant as it appears in the transactions'),
  category,
});

@Injectable()
export class SpendingTools {
  constructor(private readonly spending: SpendingService) {}

  @Tool({
    name: 'import-transactions',
    description:
      "Store the lines of a card statement. Pass every line of the statement, including repeated ones: a line that is already stored is skipped, so importing the same statement again adds nothing. Returns how many were added and skipped, and the merchants whose category was replaced by the one they already had",
    inputSchema: importTransactionsSchema,
    outputSchema: z.object({
      received: z.number().int(),
      inserted: z.number().int(),
      duplicates: z.number().int(),
      recategorized: z.array(z.object({ merchant: z.string(), from: z.string(), to: z.string() })),
    }),
    // It only adds, and a retry adds nothing.
    annotations: { destructiveHint: false, idempotentHint: true },
    scopes: ['spending:write'],
  })
  import(
    { transactions }: z.infer<typeof importTransactionsSchema>,
    _ctx: McpContext,
    @CurrentOwner() owner: Owner,
  ) {
    return this.spending.import(owner.id, transactions);
  }

  @Tool({
    name: 'search-transactions',
    description:
      'List stored transactions by day range, merchant text and category, newest first. For totals use summarize-spending instead of adding these up',
    inputSchema: searchTransactionsSchema,
    annotations: { readOnlyHint: true },
  })
  search(input: z.infer<typeof searchTransactionsSchema>, _ctx: McpContext, @CurrentOwner() owner: Owner) {
    return this.spending.search(owner.id, input);
  }

  @Tool({
    name: 'summarize-spending',
    description:
      "One month's spending: the total, the total and count of each category, and the ten merchants with the highest totals. Amounts are won; cancellations and refunds are already subtracted",
    inputSchema: summarizeSpendingSchema,
    annotations: { readOnlyHint: true },
  })
  summarize({ month }: z.infer<typeof summarizeSpendingSchema>, _ctx: McpContext, @CurrentOwner() owner: Owner) {
    return this.spending.summarize(owner.id, month);
  }

  @Tool({
    name: 'compare-months',
    description:
      'Compare a month with an earlier one, category by category, the largest increase first. `difference` is the month minus the base month, in won: positive means more was spent',
    inputSchema: compareMonthsSchema,
    annotations: { readOnlyHint: true },
  })
  compare(
    { month, baseMonth }: z.infer<typeof compareMonthsSchema>,
    _ctx: McpContext,
    @CurrentOwner() owner: Owner,
  ) {
    return this.spending.compare(owner.id, month, baseMonth ?? shiftMonth(month, -1));
  }

  @Tool({
    name: 'set-merchant-category',
    description:
      'File a merchant under another category: its stored transactions are moved, and later imports use it. Call it when the user says a merchant is in the wrong category',
    inputSchema: setMerchantCategorySchema,
    outputSchema: z.object({ merchant: z.string(), category, updatedTransactions: z.number().int() }),
    // It overwrites the merchant's category, and doing it twice changes nothing more.
    annotations: { destructiveHint: true, idempotentHint: true },
    scopes: ['spending:write'],
  })
  setMerchantCategory(
    { merchant, category }: z.infer<typeof setMerchantCategorySchema>,
    _ctx: McpContext,
    @CurrentOwner() owner: Owner,
  ) {
    return this.spending.setMerchantCategory(owner.id, merchant, category);
  }

  @Prompt({
    name: 'analyze-month',
    description: "Report on a month's spending, compared with the month before",
    argsSchema: z.object({ month }),
  })
  analyzeMonth({ month }: { month: string }): PromptMessage[] {
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${month} 지출을 분석해 줘. summarize-spending과 compare-months를 호출해서 나온 숫자만 쓰고, 직접 더하거나 추정하지 마. 순서대로: (1) 총지출과 전월 대비 증감, (2) 카테고리별 금액과 비중, (3) 전월보다 가장 많이 늘어난 카테고리 3개와 그 원인이 된 가맹점(search-transactions로 확인), (4) 지출이 큰 가맹점 5곳, (5) 다음 달에 줄일 수 있는 항목 한두 가지. 데이터가 없는 달이면 그렇다고만 말해 줘.`,
        },
      },
    ];
  }
}
