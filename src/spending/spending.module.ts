import { Module } from '@nestjs/common';
import { SpendingService } from './spending.service.js';
import { SpendingTools } from './spending.tools.js';

@Module({
  providers: [SpendingService, SpendingTools],
})
export class SpendingModule {}
