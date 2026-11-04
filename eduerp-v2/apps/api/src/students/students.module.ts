import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DuplicatesService } from './duplicates.service';
import { EnrollmentsService } from './enrollments.service';
import { GuardiansService } from './guardians.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [AuthModule],
  controllers: [StudentsController],
  providers: [DuplicatesService, GuardiansService, EnrollmentsService, StudentsService],
  exports: [DuplicatesService, GuardiansService, EnrollmentsService, StudentsService],
})
export class StudentsModule {}
