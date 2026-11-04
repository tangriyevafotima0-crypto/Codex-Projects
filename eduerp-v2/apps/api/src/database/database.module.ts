import { DynamicModule, Global, Module } from '@nestjs/common';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from './database.service';

@Global()
@Module({})
export class DatabaseModule {
  static register(config: ApiEnvConfig, customDatabaseService?: DatabaseService): DynamicModule {
    const dbProvider = customDatabaseService
      ? { provide: DatabaseService, useValue: customDatabaseService }
      : DatabaseService;

    return {
      module: DatabaseModule,
      providers: [
        { provide: API_CONFIG_TOKEN, useValue: config },
        dbProvider,
      ],
      exports: [API_CONFIG_TOKEN, DatabaseService],
    };
  }
}
