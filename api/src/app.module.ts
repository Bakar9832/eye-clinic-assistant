import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppointmentTypesController } from './appointment-types/appointment-types.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { AvailabilityController } from './availability/availability.controller.js';
import { AvailabilityService } from './availability/availability.service.js';
import { BookingService } from './booking/booking.service.js';
import { Clock, SystemClock } from './clock.js';
import { JsonOnlyMiddleware } from './http/json-only.middleware.js';
import { createValidationPipe } from './http/validation.pipe.js';
import { MeController } from './me/me.controller.js';
import { ConsoleEmailSender, EmailSender } from './notifications/email-sender.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SchedulingErrorFilter } from './scheduling-error.filter.js';

@Module({
  imports: [PrismaModule],
  controllers: [AppointmentTypesController, AvailabilityController, AuthController, MeController],
  providers: [
    AvailabilityService,
    BookingService,
    AuditService,
    AuthService,
    SessionGuard,
    // Swapped for fakes in tests.
    { provide: Clock, useClass: SystemClock },
    { provide: EmailSender, useClass: ConsoleEmailSender },
    { provide: APP_FILTER, useClass: SchedulingErrorFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(cookieParser(), JsonOnlyMiddleware).forRoutes('*path');
  }
}
