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
  DuplicateCheckResponseDto,
  DuplicatesService,
} from './duplicates.service';
import {
  EnrollmentResponseDto,
  EnrollmentsService,
  TransferEnrollmentResponseDto,
} from './enrollments.service';
import {
  GuardianInviteResponseDto,
  GuardiansService,
  GuardianSummaryViewDto,
  UnlinkGuardianResponseDto,
} from './guardians.service';
import {
  AdminStudentListResponseDto,
  AdminStudentViewDto,
  StudentsService,
} from './students.service';

@Controller('api/v1')
@UseGuards(PermissionsGuard)
export class StudentsController {
  constructor(
    @Inject(StudentsService) private readonly studentsService: StudentsService,
    @Inject(GuardiansService) private readonly guardiansService: GuardiansService,
    @Inject(EnrollmentsService) private readonly enrollmentsService: EnrollmentsService,
    @Inject(DuplicatesService) private readonly duplicatesService: DuplicatesService,
  ) {}

  @Get('students')
  @RequireRoutePolicy({
    actionId: 'listStudentsForAdmin',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listStudents(
    @Req() req: RequestWithAuthPrincipal,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('include_archived') includeArchived?: string,
    @Query('only_debtors') onlyDebtors?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AdminStudentListResponseDto> {
    return this.studentsService.listStudentsForAdmin(req.principal!, {
      search,
      status,
      include_archived: includeArchived,
      only_debtors: onlyDebtors,
      cursor,
      limit,
    });
  }

  @Post('students')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'registerStudentQuick15s',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async registerStudentQuick(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<AdminStudentViewDto> {
    return this.studentsService.registerStudentQuick15s(req, req.principal!, body);
  }

  @Get('students/duplicates')
  @RequireRoutePolicy({
    actionId: 'checkStudentDuplicateWarnings',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async checkDuplicateWarnings(
    @Req() req: RequestWithAuthPrincipal,
    @Query('full_name') fullName?: string,
    @Query('guardian_phone_e164') guardianPhoneE164?: string,
    @Query('exclude_student_id') excludeStudentId?: string,
  ): Promise<DuplicateCheckResponseDto> {
    return this.duplicatesService.checkDuplicatesForStaff(req.principal!, {
      full_name: fullName,
      guardian_phone_e164: guardianPhoneE164,
      exclude_student_id: excludeStudentId,
    });
  }

  @Get('students/:student_id')
  @RequireRoutePolicy({
    actionId: 'getStudentProfileForStaff',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async getStudentProfile(
    @Req() req: RequestWithAuthPrincipal,
    @Param('student_id') studentId: string,
  ): Promise<AdminStudentViewDto> {
    return this.studentsService.getStudentProfileForStaff(req.principal!, studentId);
  }

  @Patch('students/:student_id')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'updateOrArchiveStudent',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async updateOrArchiveStudent(
    @Req() req: RequestWithAuthPrincipal,
    @Param('student_id') studentId: string,
    @Body() body: unknown,
  ): Promise<AdminStudentViewDto> {
    return this.studentsService.updateOrArchiveStudent(req, req.principal!, studentId, body);
  }

  @Post('students/:student_id/guardians')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'linkGuardianToStudent',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async linkGuardianToStudent(
    @Req() req: RequestWithAuthPrincipal,
    @Param('student_id') studentId: string,
    @Body() body: unknown,
  ): Promise<GuardianSummaryViewDto> {
    return this.guardiansService.linkGuardianToStudent(req, req.principal!, studentId, body);
  }

  @Post('students/:student_id/guardians/:guardian_id/unlink')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'unlinkGuardianFromStudent',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async unlinkGuardianFromStudent(
    @Req() req: RequestWithAuthPrincipal,
    @Param('student_id') studentId: string,
    @Param('guardian_id') guardianId: string,
    @Body() body: unknown,
  ): Promise<UnlinkGuardianResponseDto> {
    return this.guardiansService.unlinkGuardianFromStudent(
      req,
      req.principal!,
      studentId,
      guardianId,
      body,
    );
  }

  @Patch('guardians/:guardian_id/phone')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'updateGuardianPhoneAndRevokeBot',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async updateGuardianPhone(
    @Req() req: RequestWithAuthPrincipal,
    @Param('guardian_id') guardianId: string,
    @Body() body: unknown,
  ): Promise<GuardianInviteResponseDto> {
    return this.guardiansService.updateGuardianPhoneAndRevokeBot(
      req,
      req.principal!,
      guardianId,
      body,
    );
  }

  @Post('enrollments')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createStudentEnrollment',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createEnrollment(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<EnrollmentResponseDto> {
    return this.enrollmentsService.createStudentEnrollment(req, req.principal!, body);
  }

  @Post('enrollments/:enrollment_id/withdraw')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'withdrawEnrollmentWithChurnReason',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async withdrawEnrollment(
    @Req() req: RequestWithAuthPrincipal,
    @Param('enrollment_id') enrollmentId: string,
    @Body() body: unknown,
  ): Promise<EnrollmentResponseDto> {
    return this.enrollmentsService.withdrawEnrollmentWithChurnReason(
      req,
      req.principal!,
      enrollmentId,
      body,
    );
  }

  @Post('enrollments/:enrollment_id/transfer')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'transferStudentEnrollment',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async transferEnrollment(
    @Req() req: RequestWithAuthPrincipal,
    @Param('enrollment_id') enrollmentId: string,
    @Body() body: unknown,
  ): Promise<TransferEnrollmentResponseDto> {
    return this.enrollmentsService.transferStudentEnrollment(
      req,
      req.principal!,
      enrollmentId,
      body,
    );
  }
}
