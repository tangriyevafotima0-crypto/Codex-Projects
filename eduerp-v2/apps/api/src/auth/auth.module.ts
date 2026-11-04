import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ClockService } from './clock.service';
import { PermissionsGuard } from './permissions.guard';
import { RosterController } from './roster.controller';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, StaffController, RosterController],
  providers: [ClockService, TokenService, AuthService, StaffService, PermissionsGuard],
  exports: [ClockService, TokenService, AuthService, StaffService, PermissionsGuard],
})
export class AuthModule {}
