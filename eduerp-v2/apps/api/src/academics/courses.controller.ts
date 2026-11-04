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
  CourseListResponseDto,
  CourseResponseDto,
  CoursesService,
} from './courses.service';

@Controller('api/v1/courses')
@UseGuards(PermissionsGuard)
export class CoursesController {
  constructor(@Inject(CoursesService) private readonly coursesService: CoursesService) {}

  @Get()
  @RequireRoutePolicy({
    actionId: 'listCourses',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listCourses(
    @Req() req: RequestWithAuthPrincipal,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('include_archived') includeArchived?: string,
    @Query('as_of_date') asOfDate?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CourseListResponseDto> {
    return this.coursesService.listCourses(req.principal!, {
      search,
      status,
      include_archived: includeArchived,
      as_of_date: asOfDate,
      cursor,
      limit,
    });
  }

  @Post()
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createCourse',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createCourse(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<CourseResponseDto> {
    return this.coursesService.createCourse(req, req.principal!, body);
  }

  @Patch(':course_id')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'updateOrArchiveCourse',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async updateOrArchiveCourse(
    @Req() req: RequestWithAuthPrincipal,
    @Param('course_id') courseId: string,
    @Body() body: unknown,
  ): Promise<CourseResponseDto> {
    return this.coursesService.updateOrArchiveCourse(req, req.principal!, courseId, body);
  }

  @Patch(':course_id/price')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'updateCoursePrice',
    allowedRoles: ['DIRECTOR'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async updateCoursePrice(
    @Req() req: RequestWithAuthPrincipal,
    @Param('course_id') courseId: string,
    @Body() body: unknown,
  ): Promise<CourseResponseDto> {
    return this.coursesService.updateCoursePrice(req, req.principal!, courseId, body);
  }
}
