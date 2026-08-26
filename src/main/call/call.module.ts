import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CallService } from './call.service';
import { CallGateway } from './call.gateway';
import { CallController } from './call.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [ConfigModule],
  providers: [CallService, CallGateway, PrismaService],
  controllers: [CallController],
  exports: [CallService, CallGateway],
})
export class CallModule {}
