// Vercel Routing Middleware: runs at Vercel's edge, before the vercel.json rewrites pass
// API requests on to Render. Not part of the browser bundle.
//
// Behind Vercel, Cloudflare and Render, the API can't count proxies to find the visitor's
// address (the number varies). So the first hop says it, signed: x-visitor-ip is the
// address Vercel saw, and x-proxy-secret proves the request came through here. Both
// always overwrite whatever the browser sent. The API trusts x-visitor-ip only when the
// secret matches (PROXY_SHARED_SECRET, the same value on Vercel and on Render).

import { ipAddress } from '@vercel/functions';
import { rewrite } from '@vercel/functions/middleware';

export const VISITOR_IP_HEADER = 'x-visitor-ip';
export const PROXY_SECRET_HEADER = 'x-proxy-secret';

export const config = {
  // The API paths only (the same list as the rewrites): pages and files are left alone.
  matcher: ['/auth/:path*', '/me/:path*', '/chat/:path*', '/clinic/:path*', '/availability/:path*', '/appointment-types/:path*', '/staff/:path*', '/health/:path*'],
};

export default function middleware(request: Request, env: Record<string, string | undefined> = process.env) {
  const headers = new Headers(request.headers);
  // Never pass on what a browser claims.
  headers.delete(VISITOR_IP_HEADER);
  headers.delete(PROXY_SECRET_HEADER);
  const secret = env.PROXY_SHARED_SECRET;
  const ip = ipAddress(request);
  if (secret && ip) {
    headers.set(VISITOR_IP_HEADER, ip);
    headers.set(PROXY_SECRET_HEADER, secret);
  }
  return rewrite(request.url, { request: { headers } });
}
