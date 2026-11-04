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
import { StaffUserResponseDto } from './auth.service';
import {
  PermissionsGuard,
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from './permissions.guard';
import {
  RevokeStaffSessionsResponseDto,
  StaffService,
  StaffUserListResponseDto,
} from './staff.service';

@Controller('api/v1/staff')
@UseGuards(PermissionsGuard)
export class StaffController {
  constructor(@Inject(StaffService) private readonly staffService: StaffService) {}

  @Get()
  @RequireRoutePolicy({
    actionId: 'listStaffUsers',
    allowedRoles: ['DIRECTOR'],
    unconfirmedRolesDeniedWithPolicyGate: ['ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listStaff(
    @Req() req: RequestWithAuthPrincipal,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<StaffUserListResponseDto> {
    return this.staffService.listStaffUsers(req.principal!, { cursor, limit });
  }

  @Post()
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createStaffUser',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createStaff(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<StaffUserResponseDto> {
    return this.staffService.createStaffUser(req, req.principal!, body);
  }

  @Patch(':staff_id/status')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'updateStaffStatus',
    allowedRoles: ['DIRECTOR'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async updateStatus(
    @Req() req: RequestWithAuthPrincipal,
    @Param('staff_id') staffId: string,
    @Body() body: unknown,
  ): Promise<StaffUserResponseDto> {
    return this.staffService.updateStaffStatus(req, req.principal!, staffId, body);
  }

  @Post(':staff_id/sessions/revoke')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'revokeStaffSessions',
    allowedRoles: ['DIRECTOR'],
    unconfirmedRolesDeniedWithPolicyGate: ['ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_SYSTEM_OPERATION',
  })
  public async revokeSessions(
    @Req() req: RequestWithAuthPrincipal,
    @Param('staff_id') staffId: string,
    @Body() body: unknown,
  ): Promise<RevokeStaffSessionsResponseDto> {
    return this.staffService.revokeStaffSessions(req, req.principal!, staffId, body);
  }
}
