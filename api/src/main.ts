import './config.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind proxies (Vercel, then Render) every request arrives from a proxy's address.
  // Trusting exactly that many hops makes req.ip the visitor's own address again, so
  // the per-IP limits count visitors, not proxies. 0 (the default) trusts nothing.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
