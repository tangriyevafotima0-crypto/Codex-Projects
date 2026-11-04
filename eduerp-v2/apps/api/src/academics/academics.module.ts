import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcademicAccessService } from './academic-access.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { GradesController } from './grades.controller';
import { GradesService } from './grades.service';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { SubstitutionsController } from './substitutions.controller';
import { SubstitutionsService } from './substitutions.service';

@Module({
  imports: [AuthModule],
  controllers: [
    CoursesController,
    GroupsController,
    LessonsController,
    SubstitutionsController,
    GradesController,
  ],
  providers: [
    AcademicAccessService,
    CoursesService,
    GroupsService,
    LessonsService,
    SubstitutionsService,
    GradesService,
  ],
  exports: [
    AcademicAccessService,
    CoursesService,
    GroupsService,
    LessonsService,
    SubstitutionsService,
    GradesService,
  ],
})
export class AcademicsModule {}
