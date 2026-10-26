import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AdminController } from './admin/admin.controller.js';
import { AgentTokenService } from './agent/agent-token.service.js';
import { AgentClient, HttpAgentClient } from './chat/agent-client.js';
import { ChatController } from './chat/chat.controller.js';
import { ClinicToolsService } from './mcp/clinic-tools.service.js';
import { McpController } from './mcp/mcp.controller.js';
import { OffersService } from './offers/offers.service.js';
import { ResultsService } from './results/results.service.js';
import { AdminService } from './admin/admin.service.js';
import { AppointmentTypesController } from './appointment-types/appointment-types.controller.js';
import { ClinicController } from './appointment-types/clinic.controller.js';
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
import { MyAppointmentsController } from './me/my-appointments.controller.js';
import { MyResultsController } from './me/my-results.controller.js';
import { EmailSender, emailSenderFromEnv } from './notifications/email-sender.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { NotificationsWorker } from './notifications/notifications.worker.js';
import { RetentionService } from './retention/retention.service.js';
import { RetentionWorker } from './retention/retention.worker.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SchedulingErrorFilter } from './scheduling-error.filter.js';
import { OutcomesService } from './outcomes/outcomes.service.js';
import { StaffAuthController } from './staff/staff-auth.controller.js';
import { StaffBookingsController } from './staff/staff-bookings.controller.js';
import { StaffClinicController } from './staff/staff-clinic.controller.js';
import { StaffGuard } from './staff/staff.guard.js';

@Module({
  imports: [PrismaModule],
  controllers: [
    ClinicController,
    AppointmentTypesController,
    AvailabilityController,
    AuthController,
    MeController,
    MyAppointmentsController,
    MyResultsController,
    StaffAuthController,
    StaffClinicController,
    StaffBookingsController,
    AdminController,
    McpController,
    ChatController,
  ],
  providers: [
    AvailabilityService,
    BookingService,
    OutcomesService,
    AdminService,
    AgentTokenService,
    ResultsService,
    OffersService,
    ClinicToolsService,
    AuditService,
    AuthService,
    SessionGuard,
    StaffGuard,
    NotificationsService,
    NotificationsWorker,
    RetentionService,
    RetentionWorker,
    // Swapped for fakes in tests.
    { provide: Clock, useClass: SystemClock },
    { provide: EmailSender, useFactory: () => emailSenderFromEnv() },
    { provide: AgentClient, useClass: HttpAgentClient },
    { provide: APP_FILTER, useClass: SchedulingErrorFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(cookieParser(), JsonOnlyMiddleware).forRoutes('*path');
  }
}
