import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import type { GraphQLFormattedError } from 'graphql';

/**
 * Every error leaves as { message, extensions: { code, reasons? } }. Nothing internal:
 * no stack trace, and an unexpected error's own message (which could name a table or
 * a query) is replaced.
 */
export function formatError(formatted: GraphQLFormattedError): GraphQLFormattedError {
  const extensions = formatted.extensions ?? {};
  // A REST-style refusal (httpError, e.g. from StaffGuard) carries { error, reasons } as its original body.
  const original = extensions.originalError as { error?: string; reasons?: { message?: string }[] } | undefined;
  const code = String(original?.error ?? extensions.code ?? 'INTERNAL_SERVER_ERROR');
  const reasons = original?.reasons ?? extensions.reasons;
  return {
    message: code === 'INTERNAL_SERVER_ERROR' ? 'Something went wrong.' : (original?.reasons?.[0]?.message ?? formatted.message),
    ...(formatted.path ? { path: formatted.path } : {}),
    extensions: { code, ...(reasons ? { reasons } : {}) },
  };
}

/**
 * The staff dashboard's GraphQL endpoint. Under /staff, so the staff session cookie
 * reaches it; every root query and mutation is behind StaffGuard (see resolvers.ts).
 * Read when the app starts, so tests can start one in production mode.
 */
export function staffGraphQLOptions(): ApolloDriverConfig {
  const development = process.env.NODE_ENV !== 'production';
  return {
    path: '/staff/graphql',
    autoSchemaFile: true,
    sortSchema: true,
    context: ({ req, res }: { req: Request; res: Response }) => ({ req, res }),
    // Exploring the schema (introspection, the GraphiQL page) is for development only.
    introspection: development,
    graphiql: development,
    includeStacktraceInErrorResponses: false,
    formatError,
  };
}

export const StaffGraphQLModule = GraphQLModule.forRootAsync<ApolloDriverConfig>({ driver: ApolloDriver, useFactory: staffGraphQLOptions });
