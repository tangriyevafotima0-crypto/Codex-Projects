import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
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
  CourseGroupListResponseDto,
  GroupDetailResponseDto,
  GroupsService,
} from './groups.service';

@Controller('api/v1/groups')
@UseGuards(PermissionsGuard)
export class GroupsController {
  constructor(@Inject(GroupsService) private readonly groupsService: GroupsService) {}

  @Get()
  @RequireRoutePolicy({
    actionId: 'listCourseGroups',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listCourseGroups(
    @Req() req: RequestWithAuthPrincipal,
    @Query('course_id') courseId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('include_archived') includeArchived?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CourseGroupListResponseDto> {
    return this.groupsService.listCourseGroups(req.principal!, {
      course_id: courseId,
      search,
      status,
      include_archived: includeArchived,
      cursor,
      limit,
    });
  }

  @Post()
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createCourseGroup',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createCourseGroup(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<GroupDetailResponseDto> {
    return this.groupsService.createCourseGroup(req, req.principal!, body);
  }

  @Patch(':group_id')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'updateOrArchiveCourseGroup',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async updateOrArchiveCourseGroup(
    @Req() req: RequestWithAuthPrincipal,
    @Param('group_id') groupId: string,
    @Body() body: unknown,
  ): Promise<GroupDetailResponseDto> {
    return this.groupsService.updateOrArchiveCourseGroup(
      req,
      req.principal!,
      groupId,
      body,
    );
  }
}
