import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  Consumes,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Produces,
  Public,
  Roles,
  Validate,
} from '@core/decorators';
import { HttpStatus } from '@core/http/http-status';
import type { AppModule } from '@core/module';
import { buildOpenApiDocument } from '@core/openapi/document';

@Controller('/articles')
class ArticleController {
  @Get('/')
  @Public()
  @Validate({ query: z.object({ limit: z.coerce.number().int().max(50).default(20) }) })
  list(): null {
    return null;
  }

  @Get('/:id')
  @Validate({ params: z.object({ id: z.uuid() }) })
  findById(): null {
    return null;
  }

  @Post('/')
  @Roles('editor')
  @Validate({ body: z.object({ title: z.string().min(3), tags: z.array(z.string()).optional() }) })
  createDraft(): null {
    return null;
  }

  @Patch('/:id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(): null {
    return null;
  }

  @Get('/export.csv')
  @Produces('text/csv')
  exportCsv(): null {
    return null;
  }

  @Post('/:id/cover')
  @Consumes('multipart/form-data')
  uploadCover(): null {
    return null;
  }
}

const module: AppModule = { name: 'article', controllers: [ArticleController] };
const document = buildOpenApiDocument([module]);
const paths = document.paths;

describe('buildOpenApiDocument', () => {
  it('mounts every route under the api prefix, with express params rewritten', () => {
    expect(Object.keys(paths).toSorted()).toEqual([
      '/api/v1/articles',
      '/api/v1/articles/export.csv',
      '/api/v1/articles/{id}',
      '/api/v1/articles/{id}/archive',
      '/api/v1/articles/{id}/cover',
    ]);
  });

  it('drops authentication on a public route and requires it everywhere else', () => {
    expect(paths['/api/v1/articles']?.['get']?.security).toEqual([]);
    expect(paths['/api/v1/articles']?.['post']?.security).toEqual([{ bearerAuth: [] }]);
  });

  it('documents 403 only where a role or a permission is actually required', () => {
    expect(paths['/api/v1/articles']?.['post']?.responses).toHaveProperty('403');
    expect(paths['/api/v1/articles/{id}']?.['get']?.responses).not.toHaveProperty('403');
  });

  it('turns a params schema into required path parameters', () => {
    expect(paths['/api/v1/articles/{id}']?.['get']?.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ type: 'string', format: 'uuid' }),
      },
    ]);
  });

  // A query field with a default is optional for the caller even though the parsed output
  // always carries it, which is why the document is generated from the input side of the schema.
  it('marks a defaulted query parameter as optional', () => {
    expect(paths['/api/v1/articles']?.['get']?.parameters).toEqual([
      expect.objectContaining({ name: 'limit', in: 'query', required: false }),
    ]);
  });

  it('describes the request body of a validated write', () => {
    const schema = paths['/api/v1/articles']?.['post']?.requestBody as Record<string, never>;

    expect(schema).toMatchObject({
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', required: ['title'] },
        },
      },
    });
  });

  it('uses 201 for a post, and the declared code when there is one', () => {
    expect(paths['/api/v1/articles']?.['post']?.responses).toHaveProperty('201');
    expect(paths['/api/v1/articles/{id}/archive']?.['patch']?.responses).toHaveProperty('204');
  });

  it('only promises 422 where something is validated', () => {
    expect(paths['/api/v1/articles']?.['post']?.responses).toHaveProperty('422');
    expect(paths['/api/v1/articles/{id}/archive']?.['patch']?.responses).not.toHaveProperty('422');
  });

  // Without this the document would promise a JSON envelope on a route that streams a file,
  // and a generated client would try to parse it.
  it('declares the media type a handler writes itself', () => {
    expect(paths['/api/v1/articles/export.csv']?.['get']?.responses).toMatchObject({
      '200': { content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } } },
    });
  });

  it('declares a multipart body that no zod schema can describe', () => {
    expect(paths['/api/v1/articles/{id}/cover']?.['post']?.requestBody).toMatchObject({
      required: true,
      content: { 'multipart/form-data': {} },
    });
  });

  it('names the operation after the handler', () => {
    expect(paths['/api/v1/articles']?.['get']).toMatchObject({
      tags: ['article'],
      summary: 'List',
      operationId: 'ArticleController_list',
    });
    expect(paths['/api/v1/articles/{id}']?.['get']?.summary).toBe('Find by id');
  });
});
