// The staff dashboard's GraphQL types (code-first: the schema is generated from these
// classes). Only what a dashboard needs: no dates of birth, tokens, login codes or
// session data exist on any type, so no query can return them.

import { Field, GraphQLISODateTime, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { AppointmentStatus } from '../generated/prisma/client.js';

registerEnumType(AppointmentStatus, { name: 'AppointmentStatus' });

@ObjectType({ description: 'A doctor (optometrist) patients can be booked with.' })
export class Doctor {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'As patients see it, e.g. "Dr Ayesha".' })
  name!: string;
}

@ObjectType({ description: 'Enough to recognise and contact a patient. Never their date of birth.' })
export class Patient {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true, description: 'Empty until the patient fills in their profile.' })
  fullName!: string | null;

  @Field()
  email!: string;
}

@ObjectType()
export class Appointment {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The booking reference on the ticket, e.g. EC-7K3QFM.' })
  reference!: string;

  @Field(() => GraphQLISODateTime)
  start!: Date;

  @Field(() => GraphQLISODateTime)
  end!: Date;

  @Field(() => AppointmentStatus)
  status!: AppointmentStatus;

  @Field({ description: 'The appointment type, e.g. "Routine eye test".' })
  typeName!: string;

  /** For the patient field's resolver; not in the schema. */
  patientId!: string;
}
