import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { RequestWithCorrelationId } from '../common/request-id.middleware';
import {
  AuthService,
  StaffAuthResponseDto,
  StaffLogoutResponseDto,
  StaffUserResponseDto,
} from './auth.service';
import {
  PermissionsGuard,
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from './permissions.guard';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  public async login(
    @Req() req: RequestWithCorrelationId,
    @Res({ passthrough: true }) res: ServerResponse,
    @Body() body: unknown,
  ): Promise<StaffAuthResponseDto> {
    return this.authService.loginStaff(req, res, body);
  }

  @Post('refresh')
  @HttpCode(200)
  public async refresh(
    @Req() req: RequestWithCorrelationId,
    @Res({ passthrough: true }) res: ServerResponse,
    @Body() body: unknown,
  ): Promise<StaffAuthResponseDto> {
    return this.authService.refreshStaffSession(req, res, body);
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(PermissionsGuard)
  @RequireRoutePolicy({
    actionId: 'changeStaffPassword',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    allowWhenMustChangePassword: true,
    readOnlyLicensePolicy: 'ALLOWED_SYSTEM_OPERATION',
  })
  public async changePassword(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<StaffUserResponseDto> {
    return this.authService.changeStaffPassword(req, req.principal!, body);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(PermissionsGuard)
  @RequireRoutePolicy({
    actionId: 'logoutStaffSession',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    allowWhenMustChangePassword: true,
    readOnlyLicensePolicy: 'ALLOWED_SYSTEM_OPERATION',
  })
  public async logout(
    @Req() req: RequestWithAuthPrincipal,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<StaffLogoutResponseDto> {
    return this.authService.logoutStaffSession(req, res, req.principal!);
  }
}
