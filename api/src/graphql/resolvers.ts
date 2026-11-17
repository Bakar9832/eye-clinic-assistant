import { UseGuards } from '@nestjs/common';
import { Args, Context, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { BookingService } from '../booking/booking.service.js';
import { Clock } from '../clock.js';
import { CurrentStaff, Roles, StaffGuard, type StaffActor } from '../staff/staff.guard.js';
import { loadersOf, type Loaders } from './loaders.js';
import { notFound, StaffDashboardService } from './staff-dashboard.service.js';
import { Appointment, Doctor, Patient } from './types.js';

const DATE = { description: 'A clinic-local day, e.g. 2030-01-07.' };

/** One request's GraphQL context (see graphql.config.ts); the loaders are added on first use. */
type GqlContext = { loaders?: Loaders };

@Resolver(() => Doctor)
@UseGuards(StaffGuard)
export class DoctorResolver {
  constructor(private readonly dashboard: StaffDashboardService) {}

  @Query(() => [Doctor])
  doctors() {
    return this.dashboard.doctors();
  }

  @Query(() => Doctor)
  doctor(@Args('id', { type: () => ID }) id: string) {
    return this.dashboard.doctor(id);
  }

  @ResolveField(() => [Appointment], { description: "This doctor's appointments on one day." })
  appointments(@Parent() doctor: Doctor, @Args('date', DATE) date: string) {
    return this.dashboard.appointmentsOn(date, doctor.id);
  }
}

@Resolver(() => Appointment)
@UseGuards(StaffGuard)
export class AppointmentResolver {
  constructor(
    private readonly dashboard: StaffDashboardService,
    private readonly booking: BookingService,
    private readonly clock: Clock,
  ) {}

  @Query(() => [Appointment], { description: 'Every appointment on one day, any status.' })
  appointments(@Args('date', DATE) date: string) {
    return this.dashboard.appointmentsOn(date);
  }

  @ResolveField(() => Doctor, { nullable: true, description: 'Empty for a visit without an exam, e.g. a scan.' })
  doctor(@Parent() appointment: Appointment, @Context() context: GqlContext) {
    return loadersOf(context, this.dashboard).doctorOfAppointment.load(appointment.id);
  }

  @ResolveField(() => Patient)
  async patient(@Parent() appointment: Appointment, @Context() context: GqlContext) {
    const patient = await loadersOf(context, this.dashboard).patient.load(appointment.patientId);
    if (!patient) throw notFound('Patient');
    return patient;
  }

  /**
   * The same cancel as the patient's own, acting for the appointment's patient: only
   * upcoming, booked appointments; races settled by the database; audited, with the
   * staff member as the one who did it.
   */
  @Mutation(() => Appointment)
  @Roles(['RECEPTION', 'ADMIN'])
  async cancelAppointment(@Args('id', { type: () => ID }) id: string, @CurrentStaff() staff: StaffActor) {
    const { patientId } = await this.dashboard.appointment(id);
    await this.booking.cancel(patientId, id, this.clock.now(), staff);
    return this.dashboard.appointment(id);
  }
}
