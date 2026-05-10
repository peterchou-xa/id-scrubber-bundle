import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ScrubMetricsModule } from './scrub-metrics/scrub-metrics.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'If&f98A*F7NqA',
      database: process.env.DB_NAME ?? 'identity_scrubber',
      schema: 'public',
      autoLoadEntities: true,
      synchronize: false,
    }),
    ScrubMetricsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
