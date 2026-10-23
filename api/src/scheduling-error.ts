/** Why a request was refused. The code is for programs, the message for people (and the agent). */
export interface Reason {
  code: string;
  message: string;
}

export type SchedulingErrorCode =
  | 'INVALID_DAY'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_DOCTOR'
  | 'INVALID_SLOT'
  | 'SLOT_TAKEN'
  | 'NOT_FOUND'
  | 'NOT_CANCELLABLE';

/** A refusal the caller should see, as opposed to a bug. */
export class SchedulingError extends Error {
  constructor(
    readonly code: SchedulingErrorCode,
    readonly reasons: Reason[],
  ) {
    super(`${code}: ${reasons.map((r) => r.message).join(' ')}`);
  }
}
