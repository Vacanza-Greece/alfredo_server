import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CallService } from './call.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { User } from 'src/common/decorators/user.decorator';

@ApiTags('Calls')
@Controller('webrtc')
export class CallController {
  constructor(private callService: CallService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('ice-servers')
  @ApiOperation({
    summary: 'Get short-lived STUN/TURN credentials for a WebRTC call',
  })
  @ApiResponse({
    status: 200,
    description: 'Cloudflare ICE servers, ready to pass to RTCPeerConnection',
  })
  async getIceServers() {
    return this.callService.generateIceServers();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('call-history')
  @ApiOperation({ summary: "Get the current user's recent calls" })
  async getCallHistory(@User() user: any, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    const take =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
    return this.callService.getCallHistory(user.id, take);
  }
}
