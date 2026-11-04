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
  GradesService,
  LessonGradesAndHistoryResponseDto,
  SubmitGradesResponseDto,
} from './grades.service';

@Controller('api/v1/lessons')
@UseGuards(PermissionsGuard)
export class GradesController {
  constructor(@Inject(GradesService) private readonly gradesService: GradesService) {}

  @Post(':lesson_id/grades')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'submitLessonGrades',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async submitLessonGrades(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
    @Body() body: unknown,
  ): Promise<SubmitGradesResponseDto> {
    return this.gradesService.submitLessonGrades(
      req,
      req.principal!,
      lessonId,
      body,
    );
  }

  @Get(':lesson_id/grades')
  @RequireRoutePolicy({
    actionId: 'listLessonGradesAndHistory',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listLessonGradesAndHistory(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
    @Query('student_id') studentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LessonGradesAndHistoryResponseDto> {
    return this.gradesService.listLessonGradesAndHistory(req.principal!, lessonId, {
      student_id: studentId,
      cursor,
      limit,
    });
  }
}
