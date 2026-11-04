import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  PermissionsGuard,
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from '../auth/permissions.guard';
import {
  GenerateRecurringLessonsResponseDto,
  LessonOccurrenceListResponseDto,
  LessonOccurrenceResponseDto,
  LessonsService,
} from './lessons.service';

@Controller('api/v1')
@UseGuards(PermissionsGuard)
export class LessonsController {
  constructor(@Inject(LessonsService) private readonly lessonsService: LessonsService) {}

  @Get('groups/:group_id/lessons')
  @RequireRoutePolicy({
    actionId: 'listGroupLessons',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listGroupLessons(
    @Req() req: RequestWithAuthPrincipal,
    @Param('group_id') groupId: string,
    @Query('status') status?: string,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LessonOccurrenceListResponseDto> {
    return this.lessonsService.listGroupLessons(req.principal!, groupId, {
      status,
      from_date: fromDate,
      to_date: toDate,
      cursor,
      limit,
    });
  }

  @Post('groups/:group_id/lessons')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'scheduleGroupLessonOccurrence',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async scheduleGroupLessonOccurrence(
    @Req() req: RequestWithAuthPrincipal,
    @Param('group_id') groupId: string,
    @Body() body: unknown,
  ): Promise<LessonOccurrenceResponseDto> {
    return this.lessonsService.scheduleGroupLessonOccurrence(
      req,
      req.principal!,
      groupId,
      body,
    );
  }

  @Post('groups/:group_id/lessons/generate')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'generateRecurringGroupLessons',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async generateRecurringGroupLessons(
    @Req() req: RequestWithAuthPrincipal,
    @Param('group_id') groupId: string,
    @Body() body: unknown,
  ): Promise<GenerateRecurringLessonsResponseDto> {
    return this.lessonsService.generateRecurringGroupLessons(
      req,
      req.principal!,
      groupId,
      body,
    );
  }

  @Post('lessons/:lesson_id/cancel')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'cancelLessonOccurrence',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async cancelLessonOccurrence(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
    @Body() body: unknown,
  ): Promise<LessonOccurrenceResponseDto> {
    return this.lessonsService.cancelLessonOccurrence(
      req,
      req.principal!,
      lessonId,
      body,
    );
  }
}
