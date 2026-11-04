import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  PermissionsGuard,
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from '../auth/permissions.guard';
import {
  SubstituteAssignmentResponseDto,
  SubstitutionsService,
} from './substitutions.service';

@Controller('api/v1/lessons')
@UseGuards(PermissionsGuard)
export class SubstitutionsController {
  constructor(
    @Inject(SubstitutionsService) private readonly substitutionsService: SubstitutionsService,
  ) {}

  @Post(':lesson_id/substitute')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'assignSingleLessonSubstitute',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async assignSingleLessonSubstitute(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
    @Body() body: unknown,
  ): Promise<SubstituteAssignmentResponseDto> {
    return this.substitutionsService.assignSingleLessonSubstitute(
      req,
      req.principal!,
      lessonId,
      body,
    );
  }

  @Post(':lesson_id/substitute/revoke')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'revokeSingleLessonSubstitute',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async revokeSingleLessonSubstitute(
    @Req() req: RequestWithAuthPrincipal,
    @Param('lesson_id') lessonId: string,
    @Body() body: unknown,
  ): Promise<SubstituteAssignmentResponseDto> {
    return this.substitutionsService.revokeSingleLessonSubstitute(
      req,
      req.principal!,
      lessonId,
      body,
    );
  }
}
