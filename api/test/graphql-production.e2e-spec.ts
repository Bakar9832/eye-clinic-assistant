// In production the staff dashboard's GraphQL schema can't be explored: no
// introspection, no GraphiQL page. (Development allows both: graphql.e2e-spec.ts S4.)

import { createTestApp, type TestApp } from './harness.js';

let t: TestApp;

beforeAll(async () => {
  // Read once, when the app starts (staffGraphQLOptions), so it's restored straight after.
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    t = await createTestApp();
  } finally {
    process.env.NODE_ENV = before;
  }
});
afterAll(async () => {
  await t.app.close();
});

it('P1. introspection is refused, even before any login is checked', async () => {
  const res = await t.http().post('/staff/graphql').send({ query: '{ __schema { queryType { name } } }' });
  expect(res.body.data ?? null).toBeNull();
  expect(res.body.errors[0].message).toMatch(/introspection is not allowed/i);
});

it('P2. no GraphiQL page', async () => {
  const page = await t.http().get('/staff/graphql').set('Accept', 'text/html');
  expect(page.text).not.toMatch(/graphiql/i);
});
