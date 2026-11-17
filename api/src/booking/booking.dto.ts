import { IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';

/** A new time for an appointment (and optionally a doctor). */
export class SlotDto {
  // "2030-01-07T09:00" alone is ambiguous: 9am where? The caller must say. Converting a
  // patient's "9am" into an exact time is the backend's job, using the clinic's zone.
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/, {
    message: 'start must include a time zone, e.g. 2030-01-07T04:00:00Z or 2030-01-07T09:00:00+05:00',
  })
  start!: string;

  @IsOptional()
  @IsUUID()
  doctorId?: string;
}

/** What to book, and when. The patient always comes from the session, never from here. */
export class BookDto extends SlotDto {
  @Matches(/^[A-Z_]{1,50}$/, { message: 'typeCode must look like ROUTINE_EYE_TEST' })
  typeCode!: string;
}
