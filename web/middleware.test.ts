import middleware from './middleware';

/** What the middleware asks Vercel to forward: the request headers after its changes. */
function forwarded(res: Response) {
  const keys = (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);
  return Object.fromEntries(keys.map((k) => [k, res.headers.get(`x-middleware-request-${k}`)]));
}
// Vercel sets x-real-ip to the visitor's address (ipAddress() reads it).
const visit = (headers: Record<string, string> = {}) =>
  new Request('https://site.example/chat', { method: 'POST', headers: { 'x-real-ip': '203.0.113.7', ...headers } });

describe('the edge middleware signs the visitor address for the API', () => {
  it('VI1. with the secret set: forwards the visitor address and the secret, and keeps the URL', () => {
    const res = middleware(visit(), { PROXY_SHARED_SECRET: 's3cret' });
    expect(forwarded(res)).toMatchObject({ 'x-visitor-ip': '203.0.113.7', 'x-proxy-secret': 's3cret' });
    expect(res.headers.get('x-middleware-rewrite')).toBe('https://site.example/chat');
  });

  it('VI2. what a browser sends in those headers is thrown away, never passed on', () => {
    const res = middleware(visit({ 'x-visitor-ip': '1.2.3.4', 'x-proxy-secret': 'guess' }), { PROXY_SHARED_SECRET: 's3cret' });
    expect(forwarded(res)).toMatchObject({ 'x-visitor-ip': '203.0.113.7', 'x-proxy-secret': 's3cret' });

    const unset = forwarded(middleware(visit({ 'x-visitor-ip': '1.2.3.4', 'x-proxy-secret': 'guess' }), {}));
    expect(unset).not.toHaveProperty('x-visitor-ip');
    expect(unset).not.toHaveProperty('x-proxy-secret');
  });

  it('VI3. other headers (cookies, content type) pass through unchanged', () => {
    const res = middleware(visit({ cookie: 'session=abc', 'content-type': 'application/json' }), { PROXY_SHARED_SECRET: 's3cret' });
    expect(forwarded(res)).toMatchObject({ cookie: 'session=abc', 'content-type': 'application/json' });
  });
});
