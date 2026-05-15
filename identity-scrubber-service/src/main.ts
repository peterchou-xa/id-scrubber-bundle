import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  // Capture the raw request body so the Lemon Squeezy webhook can verify the
  // HMAC signature over the exact bytes LS signed.
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
      limit: '1mb',
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.enableCors();
  await app.listen(process.env.PORT ?? 3030, '0.0.0.0');
}
bootstrap();
