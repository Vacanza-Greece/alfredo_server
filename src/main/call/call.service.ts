import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallStatus, CallType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lifetime of the TURN credentials handed to a browser. Comfortably outlives a
 * call while keeping a leaked credential short-lived.
 */
const TURN_CREDENTIAL_TTL_SECONDS = 3600;

const CLOUDFLARE_TURN_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export interface IceServersResponse {
  iceServers: unknown;
}

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Mints short-lived TURN credentials from Cloudflare Realtime.
   *
   * The long-lived key id / API token stay on the server — the browser only
   * ever sees the ephemeral username+credential pair this returns.
   */
  async generateIceServers(): Promise<IceServersResponse> {
    const keyId = this.config.get<string>('TURN_KEY_ID');
    const apiToken = this.config.get<string>('TURN_KEY_API_TOKEN');

    if (!keyId || !apiToken) {
      this.logger.error('TURN_KEY_ID / TURN_KEY_API_TOKEN are not configured');
      throw new InternalServerErrorException(
        'Calling is not configured on this server',
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${CLOUDFLARE_TURN_BASE}/${keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
        },
      );
    } catch (error) {
      this.logger.error('Could not reach Cloudflare TURN API', error as Error);
      throw new ServiceUnavailableException('Could not reach the TURN service');
    }

    if (!response.ok) {
      // Body may carry the reason (bad token, deleted key) — log it, never leak it.
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Cloudflare TURN API returned ${response.status}: ${body.slice(0, 500)}`,
      );
      throw new ServiceUnavailableException(
        'Failed to generate TURN credentials',
      );
    }

    const data = (await response.json()) as IceServersResponse;
    if (!data?.iceServers) {
      this.logger.error('Cloudflare TURN API returned no iceServers');
      throw new ServiceUnavailableException(
        'Failed to generate TURN credentials',
      );
    }

    return { iceServers: data.iceServers };
  }

  /** True when either party has blocked the other — calls go both ways. */
  async isCallBlocked(userA: string, userB: string): Promise<boolean> {
    const block = await this.prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: userA, blockedId: userB },
          { blockerId: userB, blockedId: userA },
        ],
      },
    });
    return !!block;
  }

  async getCallerIdentity(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, photo: true },
    });
  }

  // ==================== CALL RECORDS ====================
  //
  // Every write below is fail-soft: a broken history row must never take down
  // an in-progress call. Failures are logged and swallowed.

  async recordCallStarted(params: {
    callId: string;
    callerId: string;
    calleeId: string;
    callType: CallType;
    status?: CallStatus;
  }): Promise<void> {
    try {
      await this.prisma.call.create({
        data: {
          id: params.callId,
          callerId: params.callerId,
          calleeId: params.calleeId,
          callType: params.callType,
          status: params.status ?? CallStatus.RINGING,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist call ${params.callId}: ${(error as Error).message}`,
      );
    }
  }

  async recordCallAnswered(callId: string): Promise<void> {
    try {
      await this.prisma.call.update({
        where: { id: callId },
        data: { status: CallStatus.ANSWERED, answeredAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to mark call ${callId} answered: ${(error as Error).message}`,
      );
    }
  }

  async recordCallEnded(
    callId: string,
    status: CallStatus,
    endReason?: string,
  ): Promise<void> {
    try {
      await this.prisma.call.update({
        where: { id: callId },
        data: { status, endReason, endedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to close call ${callId}: ${(error as Error).message}`,
      );
    }
  }

  /** Call history between the current user and everyone they've spoken with. */
  async getCallHistory(userId: string, limit = 50) {
    return this.prisma.call.findMany({
      where: { OR: [{ callerId: userId }, { calleeId: userId }] },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        caller: { select: { id: true, fullName: true, photo: true } },
        callee: { select: { id: true, fullName: true, photo: true } },
      },
    });
  }
}
