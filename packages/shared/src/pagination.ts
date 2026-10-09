import { z } from 'zod';

// Pagination contract — Blueprint §11 ("pagination") for every scoped list.
// Offset-based is adequate for R1 list sizes; if cursor pagination replaces
// it later, item schemas are untouched — only this envelope changes.
export const PAGE_DEFAULTS = { page: 1, pageSize: 25 } as const;

// Query-string shape: values arrive as strings at the transport edge, so the
// schema coerces then validates. Page size is capped to protect the API.
export const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGE_DEFAULTS.page),
  pageSize: z.coerce.number().int().min(1).max(100).default(PAGE_DEFAULTS.pageSize),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export const PageInfoSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

// Schema factory: the paginated envelope over any item schema, so each list
// route stays a one-liner over its item contract.
export function PaginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), page: PageInfoSchema });
}

export type PaginatedResponse<T> = {
  data: T[];
  page: PageInfo;
};
