import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';

/**
 * Public: free slots only. No login, so nothing about patients or existing bookings
 * leaves this endpoint, and which technician or machine is used stays internal.
 */
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  async get(@Query('type') type?: string, @Query('day') day?: string, @Query('doctorId') doctorId?: string) {
    if (!type || !day) throw new BadRequestException('Query parameters "type" and "day" are required.');

    const { settings, slots, names } = await this.availability.getSlots({ typeCode: type, day, doctorId });

    return {
      type,
      day,
      timezone: settings.timezone,
      slots: slots.map((slot) => {
        const exam = slot.assignments.find((a) => names.get(a.resourceId)?.kind === 'OPTOMETRIST');
        return {
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          doctor: exam ? { id: exam.resourceId, displayName: names.get(exam.resourceId)!.displayName } : null,
        };
      }),
    };
  }
}
