import { Transform } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';

// Pasted emails often carry spaces; trim before the format check.
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Patients and staff log in the same way: an email, then the 6-digit code sent to it. */
export class RequestCodeDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class VerifyDto extends RequestCodeDto {
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
