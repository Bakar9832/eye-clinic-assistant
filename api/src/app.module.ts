import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppointmentTypesController } from './appointment-types/appointment-types.controller.js';
import { AvailabilityController } from './availability/availability.controller.js';
import { AvailabilityService } from './availability/availability.service.js';
import { BookingService } from './booking/booking.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SchedulingErrorFilter } from './scheduling-error.filter.js';

@Module({
  imports: [PrismaModule],
  controllers: [AppointmentTypesController, AvailabilityController],
  providers: [AvailabilityService, BookingService, { provide: APP_FILTER, useClass: SchedulingErrorFilter }],
})
export class AppModule {}
