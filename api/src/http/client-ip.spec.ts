import type { Request } from 'express';
import { clientIp, UNVERIFIED_IP, verifiedIp } from './client-ip.js';

const req = (headers: Record<string, string> = {}, ip = '10.0.0.9') => ({ headers, ip }) as unknown as Request;
const LIVE = { PROXY_SHARED_SECRET: 's3cret-value' } as NodeJS.ProcessEnv;
const signed = (ip: string, secret = 's3cret-value') => ({ 'x-visitor-ip': ip, 'x-proxy-secret': secret });

describe('the visitor address', () => {
  it('IP1. live: the signed address from the edge middleware is used (IPv4 and IPv6)', () => {
    expect(clientIp(req(signed('203.0.113.7')), LIVE)).toBe('203.0.113.7');
    expect(clientIp(req(signed('2001:db8::1')), LIVE)).toBe('2001:db8::1');
  });

  it('IP2. live: a wrong or missing secret, or no address, counts as one shared "unverified" address', () => {
    expect(clientIp(req(signed('203.0.113.7', 'guess')), LIVE)).toBe(UNVERIFIED_IP);
    expect(clientIp(req({ 'x-visitor-ip': '203.0.113.7' }), LIVE)).toBe(UNVERIFIED_IP);
    expect(clientIp(req({ 'x-proxy-secret': 's3cret-value' }), LIVE)).toBe(UNVERIFIED_IP);
    expect(clientIp(req(), LIVE)).toBe(UNVERIFIED_IP); // the API host called directly
  });

  it('IP3. live: a signed value that is not an address is refused', () => {
    expect(clientIp(req(signed('203.0.113.7, 1.2.3.4')), LIVE)).toBe(UNVERIFIED_IP);
    expect(clientIp(req(signed('not-an-ip')), LIVE)).toBe(UNVERIFIED_IP);
  });

  it('IP4. no secret set (local, tests): the connection address, and the headers are ignored', () => {
    expect(clientIp(req(signed('203.0.113.7')), {})).toBe('10.0.0.9');
    expect(verifiedIp(req(signed('203.0.113.7')), {})).toBeNull();
  });
});
