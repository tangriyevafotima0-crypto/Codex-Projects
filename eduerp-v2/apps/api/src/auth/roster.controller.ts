import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  PermissionsGuard,
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from './permissions.guard';
import { SafeGroupRosterResponseDto, StaffService } from './staff.service';

@Controller('api/v1/groups')
@UseGuards(PermissionsGuard)
export class RosterController {
  constructor(@Inject(StaffService) private readonly staffService: StaffService) {}

  @Get(':group_id/roster')
  @RequireRoutePolicy({
    actionId: 'getGroupSafeRoster',
    allowedRoles: ['DIRECTOR', 'ADMIN', 'TEACHER'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async getGroupSafeRoster(
    @Req() req: RequestWithAuthPrincipal,
    @Param('group_id') groupId: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<SafeGroupRosterResponseDto> {
    return this.staffService.getGroupSafeRoster(req.principal!, groupId, {
      search,
      cursor,
      limit,
    });
  }
}
