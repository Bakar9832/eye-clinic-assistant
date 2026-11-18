import { Transform } from 'class-transformer';
import { IsEmail, IsISO8601, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from './password.js';

// Pasted emails often carry spaces; trim before the format check.
// Passwords are never trimmed: a space can be part of one.
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Sign-up and forgot password both start here: email → a 6-digit code is sent to it. */
export class RequestCodeDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

/** The code proves the inbox; the password becomes the account's (new) password. */
export class SetPasswordDto extends RequestCodeDto {
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  // Length only (NIST 800-63B): no "one capital, one symbol" rules, which make passwords weaker.
  @IsString()
  @Length(PASSWORD_MIN, PASSWORD_MAX, { message: `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters` })
  password!: string;

  /** Sign-up asks for these too, so a new patient can book straight away. Same rules as the profile. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  fullName?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Length(10, 10, { message: 'dateOfBirth must look like 1990-01-15' })
  dateOfBirth?: string;
}

/** Patients and staff log in the same way. Any length is accepted here: a wrong one just fails. */
export class LoginDto extends RequestCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}
