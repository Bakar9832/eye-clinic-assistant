import './config.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Without PROXY_SHARED_SECRET (local development), the visitor's address is the
  // connection's, after this many trusted proxies. 0 (the default) trusts nothing. Live,
  // the chain (Vercel, Cloudflare, Render) varies, so the API uses the address the web
  // app's edge middleware signs instead: see src/http/client-ip.ts.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
