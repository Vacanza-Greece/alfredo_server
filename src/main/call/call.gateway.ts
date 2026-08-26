import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { CallStatus, CallType } from '@prisma/client';
import { CallService } from './call.service';

/** How long a call rings before we give up. Mirrors the frontend's timer. */
const RING_TIMEOUT_MS = 45_000;

type ClientCallType = 'audio' | 'video';

interface ActiveCall {
  callId: string;
  callerId: string;
  calleeId: string;
  callType: ClientCallType;
  answered: boolean;
  ringTimeout?: NodeJS.Timeout;
}

/**
 * WebRTC signalling relay.
 *
 * This gateway never inspects SDP or ICE payloads — it only decides *who* is
 * allowed to receive them. Room membership (one room per userId) is established
 * by ChatGateway.handleConnection, which runs on the same socket.
 */
@WebSocketGateway({
  cors: {
    origin: [
      'http://localhost:5173',
      'https://vacanzagreece.gr',
      'http://localhost:3000',
    ],
  },
})
export class CallGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(CallGateway.name);

  @WebSocketServer() server: Server;

  /** callId -> call */
  private activeCalls = new Map<string, ActiveCall>();
  /** userId -> callId, for busy detection */
  private userCalls = new Map<string, string>();

  constructor(private callService: CallService) {}

  // ==================== HELPERS ====================

  private getUserId(client: Socket): string | null {
    const userId = client.handshake.query.userId;
    return typeof userId === 'string' && userId ? userId : null;
  }

  /**
   * Resolves the call a socket is claiming to act on, but only if that socket's
   * user is actually a participant. Without this check any connected client
   * could inject SDP or hang up other people's calls.
   */
  private getParticipantCall(
    client: Socket,
    callId: string,
  ): { call: ActiveCall; selfId: string; otherId: string } | null {
    const selfId = this.getUserId(client);
    if (!selfId || !callId) return null;

    const call = this.activeCalls.get(callId);
    if (!call) return null;

    if (call.callerId !== selfId && call.calleeId !== selfId) {
      this.logger.warn(
        `User ${selfId} tried to act on call ${callId} they are not part of`,
      );
      return null;
    }

    const otherId = call.callerId === selfId ? call.calleeId : call.callerId;
    return { call, selfId, otherId };
  }

  private toPrismaCallType(callType: ClientCallType): CallType {
    return callType === 'video' ? CallType.VIDEO : CallType.AUDIO;
  }

  private async isUserOnline(userId: string): Promise<boolean> {
    const sockets = await this.server.in(userId).fetchSockets();
    return sockets.length > 0;
  }

  /** Removes all in-memory state for a call and clears its ring timer. */
  private forgetCall(callId: string): ActiveCall | undefined {
    const call = this.activeCalls.get(callId);
    if (!call) return undefined;

    if (call.ringTimeout) clearTimeout(call.ringTimeout);
    this.activeCalls.delete(callId);

    if (this.userCalls.get(call.callerId) === callId) {
      this.userCalls.delete(call.callerId);
    }
    if (this.userCalls.get(call.calleeId) === callId) {
      this.userCalls.delete(call.calleeId);
    }
    return call;
  }

  // ==================== SIGNALLING ====================

  @SubscribeMessage('call:initiate')
  async handleInitiate(
    @MessageBody()
    data: { callId: string; toUserId: string; callType: ClientCallType },
    @ConnectedSocket() client: Socket,
  ) {
    const callerId = this.getUserId(client);
    const { callId, toUserId, callType } = data ?? ({} as any);

    if (
      !callerId ||
      !callId ||
      !toUserId ||
      (callType !== 'audio' && callType !== 'video')
    ) {
      client.emit('call:ended', { callId, reason: 'invalid-payload' });
      return;
    }

    if (callerId === toUserId) {
      client.emit('call:ended', { callId, reason: 'invalid-payload' });
      return;
    }

    if (this.activeCalls.has(callId)) {
      client.emit('call:ended', { callId, reason: 'duplicate-call' });
      return;
    }

    // A block in either direction stops the call.
    if (await this.callService.isCallBlocked(callerId, toUserId)) {
      client.emit('call:rejected', { callId, reason: 'declined' });
      return;
    }

    // Either party already on a call?
    if (this.userCalls.has(callerId)) {
      client.emit('call:ended', { callId, reason: 'already-in-call' });
      return;
    }
    if (this.userCalls.has(toUserId)) {
      client.emit('call:rejected', { callId, reason: 'busy' });
      return;
    }

    if (!(await this.isUserOnline(toUserId))) {
      client.emit('call:unavailable', { callId });
      await this.callService.recordCallStarted({
        callId,
        callerId,
        calleeId: toUserId,
        callType: this.toPrismaCallType(callType),
        status: CallStatus.MISSED,
      });
      return;
    }

    const caller = await this.callService.getCallerIdentity(callerId);
    if (!caller) {
      client.emit('call:ended', { callId, reason: 'invalid-payload' });
      return;
    }

    const call: ActiveCall = {
      callId,
      callerId,
      calleeId: toUserId,
      callType,
      answered: false,
    };

    call.ringTimeout = setTimeout(() => {
      const stale = this.activeCalls.get(callId);
      if (!stale || stale.answered) return;

      this.forgetCall(callId);
      this.server
        .to(callerId)
        .emit('call:ended', { callId, reason: 'no-answer' });
      this.server
        .to(toUserId)
        .emit('call:ended', { callId, reason: 'no-answer' });
      void this.callService.recordCallEnded(
        callId,
        CallStatus.MISSED,
        'no-answer',
      );
    }, RING_TIMEOUT_MS);

    this.activeCalls.set(callId, call);
    this.userCalls.set(callerId, callId);
    this.userCalls.set(toUserId, callId);

    this.server.to(toUserId).emit('call:incoming', {
      callId,
      fromUserId: callerId,
      callerName: caller.fullName,
      callerAvatar: caller.photo ?? undefined,
      callType,
    });

    await this.callService.recordCallStarted({
      callId,
      callerId,
      calleeId: toUserId,
      callType: this.toPrismaCallType(callType),
    });

    this.logger.log(`Call ${callId}: ${callerId} -> ${toUserId} (${callType})`);
  }

  @SubscribeMessage('call:accept')
  async handleAccept(
    @MessageBody() data: { callId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const ctx = this.getParticipantCall(client, data?.callId);
    if (!ctx) return;

    // Only the callee can accept.
    if (ctx.call.calleeId !== ctx.selfId) return;

    ctx.call.answered = true;
    if (ctx.call.ringTimeout) {
      clearTimeout(ctx.call.ringTimeout);
      ctx.call.ringTimeout = undefined;
    }

    this.server.to(ctx.otherId).emit('call:accepted', { callId: data.callId });
    await this.callService.recordCallAnswered(data.callId);
  }

  @SubscribeMessage('call:reject')
  async handleReject(
    @MessageBody() data: { callId: string; reason?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const ctx = this.getParticipantCall(client, data?.callId);
    if (!ctx) return;

    this.forgetCall(data.callId);
    this.server.to(ctx.otherId).emit('call:rejected', {
      callId: data.callId,
      reason: data.reason ?? 'declined',
    });

    await this.callService.recordCallEnded(
      data.callId,
      CallStatus.DECLINED,
      data.reason ?? 'declined',
    );
  }

  @SubscribeMessage('call:offer')
  handleOffer(
    @MessageBody() data: { callId: string; sdp: unknown },
    @ConnectedSocket() client: Socket,
  ) {
    const ctx = this.getParticipantCall(client, data?.callId);
    if (!ctx) return;

    this.server
      .to(ctx.otherId)
      .emit('call:offer', { callId: data.callId, sdp: data.sdp });
  }

  @SubscribeMessage('call:answer')
  handleAnswer(
    @MessageBody() data: { callId: string; sdp: unknown },
    @ConnectedSocket() client: Socket,
  ) {
    const ctx = this.getParticipantCall(client, data?.callId);
    if (!ctx) return;

    this.server
      .to(ctx.otherId)
      .emit('call:answer', { callId: data.callId, sdp: data.sdp });
  }

  @SubscribeMessage('call:ice-candidate')
  handleIceCandidate(
    @MessageBody() data: { callId: string; candidate: unknown },
    @ConnectedSocket() client: Socket,
  ) {
    const ctx = this.getParticipantCall(client, data?.callId);
    if (!ctx) return;

    this.server.to(ctx.otherId).emit('call:ice-candidate', {
      callId: data.callId,
      candidate: data.candidate,
    });
  }

  @SubscribeMessage('call:end')
  async handleEnd(
    @MessageBody() data: { callId: string; reason?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const ctx = this.getParticipantCall(client, data?.callId);
    if (!ctx) return;

    const wasAnswered = ctx.call.answered;
    this.forgetCall(data.callId);

    this.server.to(ctx.otherId).emit('call:ended', {
      callId: data.callId,
      reason: data.reason ?? 'hangup',
    });

    let status: CallStatus;
    if (wasAnswered) {
      status =
        data.reason === 'connection-failed'
          ? CallStatus.FAILED
          : CallStatus.COMPLETED;
    } else {
      status =
        data.reason === 'no-answer' ? CallStatus.MISSED : CallStatus.DECLINED;
    }

    await this.callService.recordCallEnded(data.callId, status, data.reason);
  }

  // ==================== DISCONNECT ====================

  /**
   * A dropped socket must tear down its call, otherwise the surviving party
   * sits on a frozen call screen until they hang up manually.
   */
  async handleDisconnect(client: Socket) {
    const userId = this.getUserId(client);
    if (!userId) return;

    const callId = this.userCalls.get(userId);
    if (!callId) return;

    // The user may have another tab still connected — only end if fully gone.
    if (await this.isUserOnline(userId)) return;

    const call = this.forgetCall(callId);
    if (!call) return;

    const otherId = call.callerId === userId ? call.calleeId : call.callerId;
    this.server
      .to(otherId)
      .emit('call:ended', { callId, reason: 'peer-disconnected' });

    await this.callService.recordCallEnded(
      callId,
      call.answered ? CallStatus.COMPLETED : CallStatus.MISSED,
      'peer-disconnected',
    );

    this.logger.log(`Call ${callId} ended: ${userId} disconnected`);
  }
}
