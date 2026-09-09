import type { Request } from 'express';

/**
 * Request shape produced by `@Validate`: body, query and params carry the types inferred
 * from the Zod schemas instead of Express' permissive defaults.
 */
export type TypedRequest<TBody = unknown, TQuery = unknown, TParams = unknown> = Omit<
  Request,
  'body' | 'query' | 'params'
> & {
  body: TBody;
  query: TQuery;
  params: TParams;
};
