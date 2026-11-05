import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from '../auth/permissions.guard';
import { AttendanceService } from './attendance.service';
import {
  AttendanceSubmitResponseDto,
  LessonAttendanceDraftResponseDto,
  OfflineAttendanceBatchSyncResponseDto,
} from './dto';
import { SyncService } from './sync.service';

@Controller('api/v1')
export class AttendanceController {
  constructor(
    @Inject(AttendanceService)
    private readonly attendanceService: AttendanceService,
    @Inject(SyncService)
    private readonly syncService: SyncService,
  ) {}

  @Get('lessons/:lesson_id/attendance')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'getLessonAttendanceDraftOrSubmitted',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async getLessonAttendanceDraftOrSubmitted(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
  ): Promise<LessonAttendanceDraftResponseDto> {
    return this.attendanceService.getLessonAttendanceDraftOrSubmitted(
      req.principal!,
      lessonId,
    );
  }

  @Post('lessons/:lesson_id/attendance/submit')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'submitLessonAttendance',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async submitLessonAttendance(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
    @Body() body: unknown,
  ): Promise<AttendanceSubmitResponseDto> {
    return this.attendanceService.submitLessonAttendance(
      req,
      req.principal!,
      lessonId,
      body,
    );
  }

  @Post('attendance/offline-sync')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'syncOfflineAttendanceBatch',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async syncOfflineAttendanceBatch(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<OfflineAttendanceBatchSyncResponseDto> {
    return this.syncService.syncOfflineAttendanceBatch(
      req,
      req.principal!,
      body,
    );
  }
}
