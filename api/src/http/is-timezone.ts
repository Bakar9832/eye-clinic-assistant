import { ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface } from 'class-validator';
import { IANAZone } from 'luxon';

/** For `@Validate(IsTimezone)`: an IANA zone name such as Asia/Karachi. */
@ValidatorConstraint({ name: 'timezone' })
export class IsTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && IANAZone.isValidZone(value);
  }
  defaultMessage(args: ValidationArguments) {
    return `${args.property} must be an IANA zone such as Asia/Karachi or Europe/London`;
  }
}
