import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';

/**
 * Validates request bodies against their DTO classes. Unknown fields are an error, not
 * silently dropped, so a body that sneaks in "patientId" gets a 400 and shows up in logs.
 */
export function createValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        error: 'INVALID_INPUT',
        reasons: errors.flatMap((e) =>
          Object.values(e.constraints ?? { invalid: `${e.property} is invalid` }).map((message) => ({
            code: 'INVALID_INPUT',
            message,
          })),
        ),
      }),
  });
}
